import {
    CommonReconnectingWebSocket,
    NotYetConnectedError,
} from '@0cfg/stubs-common/lib/messaging/CommonReconnectingWebSocket';

import {errStatus, getOk, Reply} from '@0cfg/reply-common/lib/Reply';
import {has} from '@0cfg/utils-common/lib/has';
import {ReconnectConfig} from '@0cfg/stubs-common/lib/ReconnectingClient';
import WebSocket, {ClientOptions} from 'ws';
import http from 'http';
import {milliSecondsInASecond} from '@0cfg/utils-common/lib/timeSpan';

const CONNECTION_TIMEOUT = 2 * milliSecondsInASecond;

export class ReconnectingWebSocket extends CommonReconnectingWebSocket implements WebSocket {

    public readonly url: string;
    public readonly CLOSED = WebSocket.CLOSED;
    public readonly CLOSING = WebSocket.CLOSING;
    public readonly CONNECTING = WebSocket.CONNECTING;
    public readonly OPEN = WebSocket.OPEN;
    private readonly options: WebSocket.ClientOptions | undefined;
    private readonly expectedPingDelay: number;
    private readonly protocols: string | string[] | undefined;
    private readonly eventListeners:
        { [eventType: string]: (() => void)[] } = {
        'close': [],
        'error': [],
        'message': [],
        'open': [],
    };
    private socket: WebSocket | undefined;
    private pingTimeout: NodeJS.Timeout | undefined;
    private wasClosed: boolean = false;

    /**
     * From https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
     * Note that this api differs from the WebSocket implementation in the way that {@link connect} needs to be called
     * to establish a connection.
     * @param expectedPingDelay Sets expected ping delay in milliseconds after which a connection
     * is considered broken (and will be closed).
     * Note that the delay should be equal to the interval at which your server
     * sends out pings plus a conservative assumption of the latency.
     */
    public constructor(
        url: string,
        protocols?: string | string[],
        options?: ClientOptions,
        expectedPingDelay: number = 6000,
        reconnectConfig: ReconnectConfig = {
            reconnectTimeout: 2000,
            maxReconnects: Number.MAX_SAFE_INTEGER,
        }) {
        super(reconnectConfig);
        this.expectedPingDelay = expectedPingDelay;
        this.url = url;
        this.options = options;
        this.protocols = protocols;
    }

    protected async connectToExternalService(): Promise<Reply> {
        return new Promise<Reply>(resolve => {
            delete this.socket;
            this.socket = new WebSocket(this.url, this.protocols, this.options);
            const timeout = setTimeout(
                () => resolve(errStatus('Connection timeout.')),
                CONNECTION_TIMEOUT
            );
            this.socket.on('open', () => {
                this.heartbeat();
                clearTimeout(timeout);
                for (const eventType in this.eventListeners) {
                    this.eventListeners[eventType]
                        .forEach(listener => this.socket?.addEventListener(eventType, listener));
                }
                resolve(getOk());
            });
            this.socket.on('ping', () => this.heartbeat());
            this.socket.addEventListener('close', (ev: WebSocket.CloseEvent) => {
                resolve(getOk());
                clearTimeout(this.pingTimeout!);
                if (super.isConnected() && !this.wasClosed && !ev.wasClean) {
                    super.onDisconnect(Reply.errStatus(ev.reason));
                }
            });
            this.socket.addEventListener('error', (ev: WebSocket.ErrorEvent) => {
                clearTimeout(timeout);
                resolve(errStatus(ev.message));
            });
        });
    }

    public get binaryType(): string {
        this.throwIfNotYetConnected();
        return this.socket!.binaryType;
    }

    public get bufferedAmount(): number {
        this.throwIfNotYetConnected();
        return this.socket!.bufferedAmount;
    }

    public get extensions(): string {
        this.throwIfNotYetConnected();
        return this.socket!.extensions;
    }

    public set onclose(onclose: typeof WebSocket.prototype.onclose) {
        this.throwIfNotYetConnected();
        this.socket!.onclose = onclose;
    }

    public get onclose(): typeof WebSocket.prototype.onclose {
        this.throwIfNotYetConnected();
        return this.socket!.onclose;
    }

    /**
     * Does not survive reconnects.
     */
    public set onerror(onerror: typeof WebSocket.prototype.onerror) {
        this.throwIfNotYetConnected();
        this.socket!.onerror = onerror;
    }

    public get onerror(): typeof WebSocket.prototype.onerror {
        this.throwIfNotYetConnected();
        return this.socket!.onerror;
    }

    /**
     * Does not survive reconnects.
     */
    public set onmessage(onmessage: typeof WebSocket.prototype.onmessage) {
        this.throwIfNotYetConnected();
        this.socket!.onmessage = onmessage;
    }

    public get onmessage(): typeof WebSocket.prototype.onmessage {
        this.throwIfNotYetConnected();
        return this.socket!.onmessage as typeof WebSocket.prototype.onmessage;
    }

    /**
     * Does not survive reconnects.
     */
    public set onopen(onopen: typeof WebSocket.prototype.onopen) {
        this.throwIfNotYetConnected();
        this.socket!.onopen = onopen;
    }

    public get onopen(): typeof WebSocket.prototype.onopen {
        this.throwIfNotYetConnected();
        return this.socket!.onopen;
    }

    public get readyState(): typeof WebSocket.CONNECTING
        | typeof WebSocket.OPEN
        | typeof WebSocket.CLOSING
        | typeof WebSocket.CLOSED {
        return this.socket?.readyState ?? this.CLOSED;
    }

    public get protocol(): string {
        this.throwIfNotYetConnected();
        return this.socket!.protocol;
    }

    public close(code?: number, data?: string): void {
        this.wasClosed = true;
        this.socket?.close(code, data);
    }

    public emit(event: string | symbol, ...args: any[]): boolean {
        this.waitForConnection().then(() => this.socket?.emit(event));
        return true;
    }

    public eventNames(): Array<string | symbol> {
        this.throwIfNotYetConnected();
        return this.socket!.eventNames();
    }

    public getMaxListeners(): number {
        this.throwIfNotYetConnected();
        return this.socket!.getMaxListeners();
    }

    public listenerCount(event: string | symbol): number {
        this.throwIfNotYetConnected();
        return this.socket!.listenerCount(event);
    }

    // Inherited from superclass
    // eslint-disable-next-line @typescript-eslint/ban-types
    public listeners(event: string | symbol): Function[] {
        this.throwIfNotYetConnected();
        return this.socket!.listeners(event);
    }

    public off(event: string | symbol, listener: (...args: any[]) => void): this {
        this.waitForConnection().then(() => this.socket?.off(event, listener));
        return this;
    }

    public onMessage(listener: (data: string) => void): void {
        this.waitForConnection().then(() => this.socket?.addEventListener('message',
            (ev: WebSocket.MessageEvent) => listener(ev.data.toString())));
    }

    public once(event: string | symbol, listener: (...args: any[]) => void): this {
        this.waitForConnection().then(() => this.socket?.on(event, listener));
        return this;
    }

    public ping(data?: any, mask?: boolean, cb?: (err: Error) => void): void {
        this.socket?.ping(data, mask, cb);
    }

    public pong(data?: any, mask?: boolean, cb?: (err: Error) => void): void {
        this.socket?.pong(data, mask, cb);
    }

    public prependListener(event: string | symbol, listener: (...args: any[]) => void): this {
        this.waitForConnection().then(() => this.socket?.prependListener(event, listener));
        return this;
    }

    public prependOnceListener(event: string | symbol, listener: (...args: any[]) => void): this {
        this.waitForConnection().then(() => this.socket?.prependOnceListener(event, listener));
        return this;
    }

    // Inherited from superclass
    // eslint-disable-next-line @typescript-eslint/ban-types
    public rawListeners(event: string | symbol): Function[] {
        this.throwIfNotYetConnected();
        return this.socket!.rawListeners(event);
    }

    public removeAllListeners(event?: string | symbol): this {
        this.waitForConnection().then(() => this.socket?.removeAllListeners());
        return this;
    }

    public setMaxListeners(n: number): this {
        this.waitForConnection().then(() => this.socket?.setMaxListeners(n));
        return this;
    }

    public terminate(): void {
        this.wasClosed = true;
        this.socket?.terminate();
    }

    public removeEventListener(
        method: 'message',
        cb?: (event: { data: any; type: string; target: WebSocket }) => void): void;
    public removeEventListener
    (method: 'close',
     cb?: (event: { wasClean: boolean; code: number; reason: string; target: WebSocket }) => void): void;
    public removeEventListener(
        method: 'error',
        cb?: (event: { error: any; message: any; type: string; target: WebSocket }) => void): void;
    public removeEventListener(
        method: 'open',
        cb?: (event: { target: WebSocket }) => void): void;
    public removeEventListener(method: string, listener?: () => void): void;
    public removeEventListener(method: 'message' | 'close' | 'error' | 'open' | string, cb?:
        ((event: { data: any; type: string; target: WebSocket }) => void) |
        ((event: { wasClean: boolean; code: number; reason: string; target: WebSocket }) => void) |
        ((event: { error: any; message: any; type: string; target: WebSocket }) => void) |
        ((event: { target: WebSocket }) => void) | (() => void)): void {
        this.eventListeners[method] = this.eventListeners[method].filter(e => e !== cb);
        this.waitForConnection().then(() => this.socket?.removeEventListener(method, cb as () => void));
    }

    public removeListener(event: 'close', listener: (code: number, message: string) => void): this;
    public removeListener(event: 'error', listener: (err: Error) => void): this;
    public removeListener(event: 'upgrade', listener: (request: http.IncomingMessage) => void): this;
    public removeListener(event: 'message', listener: (data: WebSocket.Data) => void): this;
    public removeListener(event: 'open', listener: () => void): this;
    public removeListener(event: 'ping' | 'pong', listener: (data: Buffer) => void): this;
    public removeListener(
        event: 'unexpected-response',
        listener: (request: http.ClientRequest, response: http.IncomingMessage) => void): this;
    public removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
    public removeListener(event: string | symbol, listener: (...args: any[]) => void): this;
    public removeListener(
        event: 'close' | 'error' | 'upgrade' | 'message' | 'open' | 'ping' | 'pong' | 'unexpected-response' |
            string | symbol,
        listener: ((code: number, message: string) => void) |
            ((err: Error) => void) | ((request: http.IncomingMessage) => void) |
            ((data: WebSocket.Data) => void) |
            (() => void) | ((data: Buffer) => void) |
            ((request: http.ClientRequest, response: http.IncomingMessage) => void) |
            ((...args: any[]) => void)): this {
        this.waitForConnection().then(() => this.socket?.removeEventListener(event as string, listener as () => void));
        return this;
    }

    public addEventListener(
        method: 'message',
        cb: (event: { data: any; type: string; target: WebSocket }) => void,
        options?: WebSocket.EventListenerOptions): void;
    public addEventListener(
        method: 'close',
        cb: (event: { wasClean: boolean; code: number; reason: string; target: WebSocket }) => void,
        options?: WebSocket.EventListenerOptions): void;
    public addEventListener(
        method: 'error',
        cb: (event: { error: any; message: any; type: string; target: WebSocket }) => void,
        options?: WebSocket.EventListenerOptions): void;
    public addEventListener(
        method: 'open', cb: (event: { target: WebSocket }) => void, options?: WebSocket.EventListenerOptions): void;
    public addEventListener
    (method: string, listener: () => void, options?: WebSocket.EventListenerOptions): void;
    public addEventListener(
        method: 'message' | 'close' | 'error' | 'open' | string,
        cb: ((event: { data: any; type: string; target: WebSocket }) => void)
            | ((event: { wasClean: boolean; code: number; reason: string; target: WebSocket }) => void)
            | ((event: { error: any; message: any; type: string; target: WebSocket }) => void)
            | ((event: { target: WebSocket }) => void)
            | (() => void), options?: WebSocket.EventListenerOptions): void {
        this.eventListeners[method].push(cb as () => void);
        this.waitForConnection().then(() => this.socket?.addEventListener(method, cb as () => void));
    }

    public addListener(event: 'close' | 'error' | 'upgrade' | 'message' | 'open' | 'ping' | 'pong'
        | 'unexpected-response' | string | symbol,
                       listener: ((code: number, message: string) => void) |
                           ((err: Error) => void) |
                           ((request: http.IncomingMessage) => void) |
                           ((data: WebSocket.Data) => void) |
                           (() => void) | ((data: Buffer) => void) |
                           ((request: http.ClientRequest, response: http.IncomingMessage) => void) |
                           ((...args: any[]) => void)): this {
        this.waitForConnection().then(() => this.socket?.addListener(event as string, listener as () => void));
        return this;
    }

    public send(data: string): void;
    public send(data: any, cb?: (err?: Error) => void): void;
    public send(data: any,
                options: { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean },
                cb?: (err?: Error) => void): void;
    public send(data: any,
                optionsOrCb?: ((err?: Error) => void) |
                    { mask?: boolean; binary?: boolean; compress?: boolean; fin?: boolean },
                cb?: (err?: Error) => void): void {
        this.waitForConnection().then(() => this.socket?.send(data,
            optionsOrCb as {
                mask?: boolean | undefined; binary?: boolean | undefined;
                compress?: boolean | undefined; fin?: boolean | undefined;
            }, cb));
    }

    public on(event: 'close', listener: (this: WebSocket, code: number, reason: string) => void): this;
    public on(event: 'error', listener: (this: WebSocket, err: Error) => void): this;
    public on(event: 'upgrade', listener: (this: WebSocket, request: http.IncomingMessage) => void): this;
    public on(event: 'message', listener: (this: WebSocket, data: WebSocket.Data) => void): this;
    public on(event: 'open', listener: (this: WebSocket) => void): this;
    public on(event: 'ping' | 'pong', listener: (this: WebSocket, data: Buffer) => void): this;
    public on(event: 'unexpected-response',
              listener: (this: WebSocket, request: http.ClientRequest, response: http.IncomingMessage) => void): this;
    public on(event: string | symbol,
              listener: (this: WebSocket, ...args: any[]) => void): this;
    public on(event: string | symbol,
              listener: (...args: any[]) => void): this;
    public on(event: 'close' | 'error' | 'upgrade' | 'message' | 'open' | 'ping' | 'pong' | 'unexpected-response'
        | string | symbol, listener: ((this: WebSocket, code: number, reason: string) => void)
        | ((this: WebSocket, err: Error) => void) |
        ((this: WebSocket, request: http.IncomingMessage) => void)
        | ((this: WebSocket, data: WebSocket.Data) => void)
        | ((this: WebSocket) => void) | ((this: WebSocket, data: Buffer) => void)
        | ((this: WebSocket, request: http.ClientRequest, response: http.IncomingMessage) => void) |
        ((this: WebSocket, ...args: any[]) => void) | ((...args: any[]) => void)): this {
        this.waitForConnection().then(() => this.socket?.on(event, listener));
        return this;
    }

    public onClose(listener: (message: string) => void): void {
        this.resolveWhenConnected().then(() => this.socket?.addEventListener('close', (ev) => listener(ev.reason)));
    }

    private async waitForConnection(): Promise<void> {
        if (!super.isConnected()) {
            await super.resolveWhenConnected();
        }
    }

    private throwIfNotYetConnected(): void {
        if (!has(this.socket)) {
            throw new NotYetConnectedError();
        }
    }

    private heartbeat(): void {
        this.pingTimeout && clearTimeout(this.pingTimeout);
        // Use `WebSocket#terminate()`, which immediately destroys the connection,
        // instead of `WebSocket#close()`, which waits for the close timer.
        this.pingTimeout = setTimeout(() => {
            this.terminate();
        }, this.expectedPingDelay);
    }

}
