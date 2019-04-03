/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IChannel, IServerChannel } from 'vs/base/parts/ipc/common/ipc';
import { Event, Emitter } from 'vs/base/common/event';
import { StorageMainService, IStorageChangeEvent } from 'vs/platform/storage/node/storageMainService';
import { IUpdateRequest, IStorageDatabase, IStorageItemsChangeEvent } from 'vs/base/node/storage';
import { mapToSerializable, serializableToMap, values } from 'vs/base/common/map';
import { Disposable, IDisposable, dispose } from 'vs/base/common/lifecycle';
import { onUnexpectedError } from 'vs/base/common/errors';
import { ILogService } from 'vs/platform/log/common/log';
import { generateUuid } from 'vs/base/common/uuid';
import { instanceStorageKey, firstSessionDateStorageKey, lastSessionDateStorageKey, currentSessionDateStorageKey } from 'vs/platform/telemetry/node/workbenchCommonProperties';

type Key = string;
type Value = string;
type Item = [Key, Value];

interface ISerializableUpdateRequest {
	insert?: Item[];
	delete?: Key[];
}

interface ISerializableItemsChangeEvent {
	items: Item[];
}

export class GlobalStorageDatabaseChannel extends Disposable implements IServerChannel {

	private static STORAGE_CHANGE_DEBOUNCE_TIME = 100;

	private readonly _onDidChangeItems: Emitter<ISerializableItemsChangeEvent> = this._register(new Emitter<ISerializableItemsChangeEvent>());
	get onDidChangeItems(): Event<ISerializableItemsChangeEvent> { return this._onDidChangeItems.event; }

	private whenReady: Promise<void>;

	constructor(
		private logService: ILogService,
		private storageMainService: StorageMainService
	) {
		super();

		this.whenReady = this.init();
	}

	private init(): Promise<void> {
		return this.storageMainService.initialize().then(undefined, error => {
			onUnexpectedError(error);
			this.logService.error(error);
		}).then(() => {

			// Apply global telemetry values as part of the initialization
			// These are global across all windows and thereby should be
			// written from the main process once.
			this.initTelemetry();

			// Setup storage change listeners
			this.registerListeners();
		});
	}

	private initTelemetry(): void {
		const instanceId = this.storageMainService.get(instanceStorageKey, undefined);
		if (instanceId === undefined) {
			this.storageMainService.store(instanceStorageKey, generateUuid());
		}

		const firstSessionDate = this.storageMainService.get(firstSessionDateStorageKey, undefined);
		if (firstSessionDate === undefined) {
			this.storageMainService.store(firstSessionDateStorageKey, new Date().toUTCString());
		}

		const lastSessionDate = this.storageMainService.get(currentSessionDateStorageKey, undefined); // previous session date was the "current" one at that time
		const currentSessionDate = new Date().toUTCString(); // current session date is "now"
		this.storageMainService.store(lastSessionDateStorageKey, typeof lastSessionDate === 'undefined' ? null : lastSessionDate);
		this.storageMainService.store(currentSessionDateStorageKey, currentSessionDate);
	}

	private registerListeners(): void {

		// Listen for changes in global storage to send to listeners
		// that are listening. Use a debouncer to reduce IPC traffic.
		this._register(Event.debounce(this.storageMainService.onDidChangeStorage, (prev: IStorageChangeEvent[], cur: IStorageChangeEvent) => {
			if (!prev) {
				prev = [cur];
			} else {
				prev.push(cur);
			}

			return prev;
		}, GlobalStorageDatabaseChannel.STORAGE_CHANGE_DEBOUNCE_TIME)(events => {
			if (events.length) {
				this._onDidChangeItems.fire(this.serializeEvents(events));
			}
		}));
	}

	private serializeEvents(events: IStorageChangeEvent[]): ISerializableItemsChangeEvent {
		const items = new Map<Key, Value>();
		events.forEach(event => items.set(event.key, this.storageMainService.get(event.key)));

		return { items: mapToSerializable(items) };
	}

	listen(_: unknown, event: string): Event<any> {
		switch (event) {
			case 'onDidChangeItems': return this.onDidChangeItems;
		}

		throw new Error(`Event not found: ${event}`);
	}

	call(_: unknown, command: string, arg?: any): Promise<any> {
		switch (command) {
			case 'getItems': {
				return this.whenReady.then(() => mapToSerializable(this.storageMainService.items));
			}

			case 'updateItems': {
				return this.whenReady.then(() => {
					const items: ISerializableUpdateRequest = arg;
					if (items.insert) {
						for (const [key, value] of items.insert) {
							this.storageMainService.store(key, value);
						}
					}

					if (items.delete) {
						items.delete.forEach(key => this.storageMainService.remove(key));
					}
				});
			}

			case 'checkIntegrity': {
				return this.whenReady.then(() => this.storageMainService.checkIntegrity(arg));
			}
		}

		throw new Error(`Call not found: ${command}`);
	}
}

export class GlobalStorageDatabaseChannelClient extends Disposable implements IStorageDatabase {

	_serviceBrand: any;

	private readonly _onDidChangeItemsExternal: Emitter<IStorageItemsChangeEvent> = this._register(new Emitter<IStorageItemsChangeEvent>());
	get onDidChangeItemsExternal(): Event<IStorageItemsChangeEvent> { return this._onDidChangeItemsExternal.event; }

	private onDidChangeItemsOnMainListener: IDisposable;

	constructor(private channel: IChannel) {
		super();

		this.registerListeners();
	}

	private registerListeners(): void {
		this.onDidChangeItemsOnMainListener = this.channel.listen('onDidChangeItems')((e: ISerializableItemsChangeEvent) => this.onDidChangeItemsOnMain(e));
	}

	private onDidChangeItemsOnMain(e: ISerializableItemsChangeEvent): void {
		if (Array.isArray(e.items)) {
			this._onDidChangeItemsExternal.fire({ items: serializableToMap(e.items) });
		}
	}

	getItems(): Promise<Map<string, string>> {
		return this.channel.call('getItems').then((data: Item[]) => serializableToMap(data));
	}

	updateItems(request: IUpdateRequest): Promise<void> {
		let updateCount = 0;
		const serializableRequest: ISerializableUpdateRequest = Object.create(null);

		if (request.insert) {
			serializableRequest.insert = mapToSerializable(request.insert);
			updateCount += request.insert.size;
		}

		if (request.delete) {
			serializableRequest.delete = values(request.delete);
			updateCount += request.delete.size;
		}

		if (updateCount === 0) {
			return Promise.resolve(); // prevent work if not needed
		}

		return this.channel.call('updateItems', serializableRequest);
	}

	checkIntegrity(full: boolean): Promise<string> {
		return this.channel.call('checkIntegrity', full);
	}

	close(): Promise<void> {

		// when we are about to close, we start to ignore main-side changes since we close anyway
		this.onDidChangeItemsOnMainListener = dispose(this.onDidChangeItemsOnMainListener);

		return Promise.resolve(); // global storage is closed on the main side
	}

	dispose(): void {
		super.dispose();

		this.onDidChangeItemsOnMainListener = dispose(this.onDidChangeItemsOnMainListener);
	}
}