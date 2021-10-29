import * as net from 'net';
import * as http from 'http';
import 'reflect-metadata';
import * as express from 'express';
import WebSocket from 'ws';
import {isA} from 'ts-type-checked';
import {has} from '@0cfg/utils-common/lib/has';
import {inRange} from '@0cfg/utils-common/lib/inRange';
import {JsonValue} from '@0cfg/utils-common/lib/JsonValue';
import {forEachProperty} from '@0cfg/utils-common/lib/forEachProperty';
import {
    errStatus,
    getOk,
    okStatus,
    Reply,
    ReplyPromise,
    SerializedReply,
    UnknownReply,
    UnknownReplyPromise,
} from '@0cfg/reply-common/lib/Reply';
import {HttpStatusCode} from '@0cfg/http-common/lib/HttpStatusCode';
import {WebSocketEvent} from '@0cfg/rpc-common/lib/websocket/WebSocketEvent';
import {WebSocketServerMessage} from '@0cfg/rpc-common/lib/websocket/WebSocketServerMessage';
import {CLIENT_CONTEXT_METHOD, HttpContext} from '@0cfg/rpc-common/lib/HttpContext';
import {LogTag} from '@0cfg/reply-common/lib/log';
import {milliSecondsInASecond} from '@0cfg/utils-common/lib/timeSpan';
import {COMPLETE_METHOD} from '@0cfg/rpc-common/lib/stub/reservedRpcMethods';
import {WebSocketClientMessage} from '@0cfg/rpc-common/lib/websocket/WebSocketClientMessage';
import {AnyRequestReplyService} from './RequestReplyService';
import {AnyBidiStreamService, AnyBidiStreamServiceFactory} from './BidiStreamService';
import {AnyServerStreamService, AnyServerStreamServiceFactory} from './ServerStreamService';
import {Middleware} from './Middleware';
import {definedValues} from '@0cfg/utils-common/lib/definedValues';

const UNKNOWN_REQUEST_ID = 0;

export const DEFAULT_PORT = 3000;
export const DEFAULT_BASE_URL = '/';
const MIN_PORT_ALLOWED = 1025;
const MAX_PORT_ALLOWED = 65535;

const SUPPORTED_CONTENT_TYPES = ['text/plain', 'application/json'];

const bodyParserMiddleware = express.text({type: SUPPORTED_CONTENT_TYPES});

export class InvalidPortError extends Error {
    public constructor(port: number) {
        super(`Invalid port specified. Must be between 1024 and 65535, but was ${port}.`);
    }
}

export class ReservedNameError extends Error {
    public constructor(name: string) {
        super(`"${name}" is already reserved for another rpc action.`);
    }
}

export class DuplicateHeaderError extends Error {
    public constructor(header: string) {
        super(`Header "${header}" can be set only once.`);
    }
}

export class InvalidBaseUrlError extends Error {
    public constructor(baseUrl: string) {
        super(`The base url "${baseUrl}" is required to start (but not end) with "/".`);
    }
}

const invalidJSON = (e: Error) => errStatus(
    `The request body is not a valid JSON string (Error message: ${e.message}).`);

const invalidContextT = () => errStatus(
    'The provided context is not of the same type as the server context.');

const unknownMethod = (method: string) => errStatus(
    `The provided method '${method}' is not exposed by the server.`);

const disconnectedDueToTimeout = (timeout: number) => errStatus(`Disconnected due to timeout (${timeout}ms).`);

type StaticPath = { url: string, filePath: string };

const httpContext = (req?: express.Request): HttpContext => {
    return {
        requestHeaders: req?.headers ?? {},
        httpStatusCode: HttpStatusCode.Ok,
        responseHeaders: {},
    };
};

type InternalRpcServerConfig<Context extends HttpContext> = {
    port: number,
    expressApp: express.Application | undefined,
    baseUrl: string,
    responseHeaders: http.OutgoingHttpHeaders,
    reservedNames: Record<string, boolean>,
    requestReplyList: AnyRequestReplyService<Context>[],
    bidiStreamFactoryList: AnyBidiStreamServiceFactory<Context>[];
    serverStreamFactoryList: AnyServerStreamServiceFactory<Context>[];
    staticPaths: StaticPath[],
    middlewareQueue: Middleware<unknown, Context>[],
    contextFactory: ContextFactory<Context>,
    connectionTimeout: number
};

type ContextFactory<Context extends HttpContext> = (req: express.Request) => Context;
const DEFAULT_CONTEXT_FACTORY_FACTORY =
    <Context extends HttpContext>() =>
        (req: express.Request) => httpContext(req) as unknown as Context;

type BidiStreamMap<Context extends HttpContext> = { [requestId: number]: AnyBidiStreamService<Context> };
type ServerStreamMap<Context extends HttpContext> = { [requestId: number]: AnyServerStreamService<Context> };

/**
 * The namespace is necessary in Typescript v. 3.9.7 in order to provide a
 * Java static inner class like behaviour while having a private constructor
 * for the inner class, and a static factory for the outer class.
 */
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace RpcServerConfig {
    /**
     * Builder pattern for {@link RpcServerConfig}
     */
    export interface Builder<Context extends HttpContext = HttpContext> {
        /**
         * Set the port on which the {@link RpcServer} will listen.
         * Note that this will have no effect if a pre-initialized express app was set,
         * only if the underlying server is already listening on a port.
         */
        setPort(port: number): Builder<Context>;

        /** Set a prefix url that will apply to all endpoints of the {@link RpcServer}. */
        setBaseUrl(baseUrl: string): Builder<Context>;

        /** Set an outgoing header which will be send with every response which is
         *  propagated by the {@link RpcServer}. */
        setResponseHeader(headerKey: string, headerValue: string[]): Builder<Context>;

        /** Set the outgoing headers to allow all origins, headers, and request methods.
         * Note that this is not intended for production use.
         * @deprecated, use {@link this.setResponseHeader} instead.
         */
        allowAllOriginsAndHeadersAndRequests(): Builder<Context>;

        /**
         * Bind a {@link RequestReplyService} service to the server and
         * listens for requests at ${baseUrl}/${service.getName()}.
         */
        addRequestReplyService(requestReplyService: AnyRequestReplyService<Context>): Builder<Context>;

        /**
         * Bind a {@link RequestReply} service to the server and
         * listens for requests at ${baseUrl}/${service.getName()}.
         */
        addBidiStreamService(factory: AnyBidiStreamServiceFactory<Context>): Builder<Context>;

        /**
         * Bind a {@link ServerStreamService} service to the server and
         * listens for requests at ${baseUrl}/${service.getName()}.
         */
        addServerStreamService(factory: AnyServerStreamServiceFactory<Context>): Builder<Context>;

        /**
         * Bind a {@link RequestReply} service to the server and
         * listens for requests at ${baseUrl}/${url}.
         */
        addStaticPath(url: string, filePath: string): Builder<Context>;

        /**
         * Bind a {@link Middleware} which runs before any request to the server is made.
         */
        addServerMiddleware(middleware: Middleware<unknown, Context>): Builder<Context>;

        /**
         * Set the factory to create the server context.
         * The server will create a {@link HttpContext} and cast it to the provided context type if none is set.
         */
        setContextFactory(contextFactory: ContextFactory<Context>): Builder<Context>;

        /**
         * Specify a timeout before a websocket connection is considered disconnected
         * (after the last ping from the client).
         */
        setConnectionTimeout(timeout: number): RpcServerConfig.Builder<Context>;

        /**
         * Reuse an express app that has already been set up.
         * Note that this conflicts with the port setting if the underlying server is already running.
         * It is not necessary to set an express app if you do not want to reuse an existing app.
         * @param routers that have already been set up for the app
         */
        setExpressApp(app: express.Application, ...routers: express.Router[]): RpcServerConfig.Builder<Context>;

        /**
         * Create a new {@link RpcServer} object.
         */
        build(): RpcServerConfig<Context>;
    }
}

/**
 * Readonly config builder pattern for the {@link RpcServer}.
 */
export class RpcServerConfig<Context extends HttpContext = HttpContext> implements InternalRpcServerConfig<Context> {

    private static BuilderImpl = class<Context extends HttpContext> implements RpcServerConfig.Builder<Context> {
        private defaultConfig: InternalRpcServerConfig<Context> = {
            port: DEFAULT_PORT,
            baseUrl: DEFAULT_BASE_URL,
            responseHeaders: {},
            reservedNames: {
                [COMPLETE_METHOD]: true,
                [CLIENT_CONTEXT_METHOD]: true,
            },
            requestReplyList: [],
            bidiStreamFactoryList: [],
            serverStreamFactoryList: [],
            staticPaths: [],
            middlewareQueue: [],
            contextFactory: DEFAULT_CONTEXT_FACTORY_FACTORY<Context>(),
            connectionTimeout: 10 * milliSecondsInASecond,
            expressApp: undefined,
        };

        public constructor() {
        }

        public setPort(
            port: number
        ): RpcServerConfig.Builder<Context> {
            if (!inRange(port, MIN_PORT_ALLOWED, MAX_PORT_ALLOWED)) {
                throw new InvalidPortError(port);
            }
            this.defaultConfig.port = port;
            return this;
        }

        public setBaseUrl(
            baseUrl: string
        ): RpcServerConfig.Builder<Context> {
            if (baseUrl.endsWith('\/') || !baseUrl.startsWith('\/')) {
                throw new InvalidBaseUrlError(baseUrl);
            }
            this.defaultConfig.baseUrl = baseUrl;
            return this;
        }

        public setResponseHeader(
            headerKey: string,
            headerValue: string[]
        ): RpcServerConfig.Builder<Context> {
            this.defaultConfig.responseHeaders[headerKey] = headerValue;
            return this;
        }

        public allowAllOriginsAndHeadersAndRequests(): RpcServerConfig.Builder<Context> {
            return this.setResponseHeader('Access-Control-Allow-Origin', ['*'])
                .setResponseHeader('Access-Control-Allow-Headers',
                    ['Origin', 'X-Requested-With', 'Content-Type', 'Accept',
                        'Methods', 'authorization'])
                .setResponseHeader('Access-Control-Allow-Methods',
                    ['GET', 'POST', 'PUT', 'PATCH',
                        'DELETE', 'OPTIONS']);
        }

        public addRequestReplyService(
            request: AnyRequestReplyService<Context>
        ): RpcServerConfig.Builder<Context> {
            this.reserve(request.getName());
            this.defaultConfig.requestReplyList.push(request);
            return this;
        }

        public addBidiStreamService(
            factory: AnyBidiStreamServiceFactory<Context>
        ): RpcServerConfig.Builder<Context> {
            this.reserve(factory.getName());
            this.defaultConfig.bidiStreamFactoryList.push(factory);
            return this;
        }

        public addServerStreamService(
            factory: AnyServerStreamServiceFactory<Context>
        ): RpcServerConfig.Builder<Context> {
            this.reserve(factory.getName());
            this.defaultConfig.serverStreamFactoryList.push(factory);
            return this;
        }

        public addStaticPath(
            url: string,
            filePath: string
        ): RpcServerConfig.Builder<Context> {
            this.reserve(url.split('/')[0]);
            this.defaultConfig.staticPaths.push({url: url, filePath: filePath});
            return this;
        }

        public addServerMiddleware(
            middleware: Middleware<unknown, Context>
        ): RpcServerConfig.Builder<Context> {
            this.defaultConfig.middlewareQueue.push(middleware);
            return this;
        }

        public setContextFactory(
            contextFactory: ContextFactory<Context>
        ): RpcServerConfig.Builder<Context> {
            this.defaultConfig.contextFactory = contextFactory;
            return this;
        }

        public setConnectionTimeout(
            timeout: number
        ): RpcServerConfig.Builder<Context> {
            this.defaultConfig.connectionTimeout = timeout;
            return this;
        }

        public setExpressApp(
            app: express.Application,
            ...routers: express.Router[]
        ): RpcServerConfig.Builder<Context> {
            const getRoutePaths = (stack: any[]): string[] => stack
                .map(layer => layer.route?.path)
                .filter(has);

            const getFirstPathElement = (path: any) => path.split('/')[0];

            // Reserve all routes that have already been set in the Express server.
            [
                ...getRoutePaths(app._router.stack),
                ...routers.flatMap(router => getRoutePaths(router.stack)),
            ]
                .map(path => getFirstPathElement(path))
                .forEach(this.reserve.bind(this));

            this.defaultConfig.expressApp = app;

            return this;
        }

        public build(): RpcServerConfig<Context> {
            return new RpcServerConfig(this.defaultConfig);
        }

        private reserve(name: string): void {
            if (has(this.defaultConfig.reservedNames[name])) {
                throw new ReservedNameError(name);
            }
            this.defaultConfig.reservedNames[name] = true;
        }
    };
    public readonly port: number;
    public readonly baseUrl: string;
    public readonly responseHeaders: http.OutgoingHttpHeaders;
    public readonly reservedNames: Record<string, boolean>;
    public readonly requestReplyList: AnyRequestReplyService<Context>[];
    public readonly staticPaths: StaticPath[];
    public readonly middlewareQueue: Middleware<unknown, Context>[];
    public readonly contextFactory: ContextFactory<Context>;
    public readonly bidiStreamFactoryList: AnyBidiStreamServiceFactory<Context>[];
    public readonly serverStreamFactoryList: AnyServerStreamServiceFactory<Context>[];
    public readonly connectionTimeout: number;
    public readonly expressApp: undefined | express.Application;

    private constructor(config: InternalRpcServerConfig<Context>) {
        this.port = config.port;
        this.baseUrl = config.baseUrl;
        this.responseHeaders = config.responseHeaders;
        this.reservedNames = config.reservedNames;
        this.requestReplyList = config.requestReplyList;
        this.staticPaths = config.staticPaths;
        this.bidiStreamFactoryList = config.bidiStreamFactoryList;
        this.serverStreamFactoryList = config.serverStreamFactoryList;
        this.middlewareQueue = config.middlewareQueue;
        this.contextFactory = config.contextFactory;
        this.connectionTimeout = config.connectionTimeout;
        this.expressApp = config.expressApp;
    }

    public static newBuilder<Context extends HttpContext>(): RpcServerConfig.Builder<Context> {
        return new RpcServerConfig.BuilderImpl();
    }
}

/**
 * RpcServer implementation based on express and http.
 */
export class RpcServer<Context extends HttpContext> {
    private readonly config: RpcServerConfig<Context>;
    private readonly httpServer: http.Server;
    private readonly expressApp: express.Application;
    private readonly webSocketServer: WebSocket.Server;

    public constructor(config: RpcServerConfig<Context>) {
        this.config = config;
        this.expressApp = this.setupExpressEndpoint();
        this.httpServer = http.createServer(this.expressApp);
        this.webSocketServer = this.setupWebSocketEndpoint(this.httpServer);
    }

    public static listen<Context extends HttpContext>(
        config?: RpcServerConfig<Context>
    ): Promise<RpcServer<Context>> {
        return (new RpcServer<Context>(config ?? RpcServerConfig.newBuilder<Context>().build())).listen();
    }

    private static send<T>(
        socket: WebSocket,
        outgoingMessage: WebSocketServerMessage<T>
    ): void {
        socket.send(JSON.stringify(outgoingMessage));
    }

    private static sendOk(
        socket: WebSocket,
        message: WebSocketClientMessage<JsonValue>
    ) {
        RpcServer.send(socket, {
            requestId: message.requestId,
            reply: getOk().toSerializedReply(),
        });
    }

    private static parseRawMessage(
        socket: WebSocket,
        rawMessage: WebSocket.Data
    ): WebSocketClientMessage<JsonValue> | undefined {
        try {
            /**
             * Note that JSON.parse will prevent all unwanted values from getting through the parsing.
             */
            return JSON.parse(rawMessage.toString());
        } catch (error) {
            RpcServer.send(socket, {
                requestId: UNKNOWN_REQUEST_ID,
                reply: invalidJSON(error).toSerializedReply(),
            });

            return;
        }
    }

    private static async sendUnknownMethod(
        socket: WebSocket,
        message: WebSocketClientMessage<any>
    ) {
        RpcServer.send(socket,
            {
                requestId: message.requestId,
                reply: unknownMethod(message.method as string).toSerializedReply(),
            });
    }

    private static handleUpgrade(webSocketServer: WebSocket.Server): WebSocket.Server {
        webSocketServer.on(WebSocketEvent.Upgrade, (request: http.IncomingMessage,
                                                    socket: net.Socket, head: Buffer) => {
            webSocketServer.handleUpgrade(request, socket, head, function (ws) {
                webSocketServer.emit(WebSocketEvent.Connect, ws, request);
            });
        });
        return webSocketServer;
    }

    public async listen(): Promise<RpcServer<Context>> {
        if (this.httpServer.listening) {
            // Cast is necessary because NodeJs types are wrong
            // (See: https://nodejs.org/api/net.html#net_class_net_server)
            okStatus(`RpcServer is already running and listening on port ${
                (this.httpServer.address() as net.AddressInfo).port}.`).log();
            return this;
        }
        await new Promise(resolve => this.httpServer.listen(this.config.port, resolve as () => void));
        okStatus(`RpcServer started and is listening on port ${this.config.port}.`).log();
        return this;
    }

    public async close(): Promise<RpcServer<Context>> {
        await new Promise(resolve => this.webSocketServer.close(() => this.httpServer.close(resolve)));
        return this;
    }

    private setupExpressEndpoint(): express.Application {
        const app: express.Application = this.config.expressApp ?? express.default();
        const router: express.Router = express.Router();
        this.enableHealthz(router);
        this.applyRequestReplyList(router);
        this.applyHeaders(router);
        app.use(this.config.baseUrl, router);
        return app;
    }

    private enableHealthz(
        router: express.Router
    ): void {
        router.get('/healthz', (req, res) => {
            return res.status(200).end();
        });
    }

    private applyHeaders(
        router: express.Router
    ): void {
        router.use((req, res) => {
            forEachProperty(this.config.responseHeaders, (headerKey,
                                                          headerValue): void => {
                if (has(headerValue)) {
                    res.header(headerKey as string, (headerValue as string[]).join(', '));
                }
            });
        });
    }

    private applyRequestReplyList(
        router: express.Router
    ): void {
        this.config.requestReplyList.forEach(service => {
            router.post(
                `/${service.getName()}`,
                bodyParserMiddleware,
                (req, res) => this.requestReplyViaHttp(service, req, res)
            );
        });
    }

    private async requestReplyViaHttp(
        service: AnyRequestReplyService<Context>,
        req: express.Request,
        res: express.Response
    ): Promise<void> {
        const mutableContext = this.config.contextFactory(req);

        if (
            !has(req.headers['content-type']) ||
            !SUPPORTED_CONTENT_TYPES.includes(req.headers['content-type'].split(';')[0])
        ) {
            mutableContext.httpStatusCode = HttpStatusCode.BadRequest;
            this.replyViaHttp(
                Reply.errStatus(`Supported content types: ${SUPPORTED_CONTENT_TYPES.join(', ')}`),
                mutableContext,
                res
            );
            return;
        }

        let args: JsonValue = {};
        try {
            args = (typeof req.body === 'string') ? JSON.parse(req.body) : req.body;
        } catch (e) {
            mutableContext.httpStatusCode = HttpStatusCode.BadRequest;
            this.replyViaHttp(invalidJSON(e), mutableContext, res);
            return;
        }

        const serverValidation = await this.runServerMiddleware(args, mutableContext);
        if (serverValidation.notOk()) {
            this.replyViaHttp(serverValidation, mutableContext, res);
            return;
        }

        const reply = await this.runServiceMiddlewareAndExecuteRequestReply(service, args, mutableContext);
        this.replyViaHttp(reply, mutableContext, res);
    }

    private async replyViaHttp(
        reply: UnknownReply,
        mutableContext: Context,
        res: express.Response
    ) {
        forEachProperty(mutableContext.responseHeaders,
            (key: string | number, value: string | number | string[] | undefined) => {
                res.header(key as string, value as string[]);
            });
        res.status(mutableContext.httpStatusCode).send(reply.toSerializedReply());
    }

    private setupWebSocketEndpoint(httpServer: http.Server): WebSocket.Server {
        return RpcServer.handleUpgrade(new WebSocket.Server({
            clientTracking: true,
            server: httpServer,
        })).on(WebSocketEvent.Connect, this.connectWebSocket.bind(this));
    }

    private async connectWebSocket(socket: WebSocket): Promise<void> {
        const mutableContext = this.config.contextFactory({} as express.Request) as Context;
        const bidiStreams: BidiStreamMap<Context> = {};
        const serverStreams: ServerStreamMap<Context> = {};

        socket.on(WebSocketEvent.Message, async (rawMessage: WebSocket.Data) =>
            this.handleClientMessage(bidiStreams, serverStreams, mutableContext, rawMessage, socket));

        await this.handleDisconnectedOrBroken(socket);
        [...definedValues(bidiStreams), ...definedValues(serverStreams)].forEach(stream => stream.complete);
    }

    private async handleDisconnectedOrBroken(socket: WebSocket): Promise<Reply> {
        let isAlive = true;
        let propagateDisconnect: ((reply: Reply) => void) | undefined = undefined;
        const awaitableDisconnect = new Promise<Reply>(resolve => {
            propagateDisconnect = resolve;
        });

        // Client heartbeat
        socket.on('pong', () => {
            isAlive = true;
        });

        // Ping at least once every second to keep the socket connection alive.
        const pingInterval = setInterval(() => socket.ping(), milliSecondsInASecond);
        const liveCheckInterval = setInterval(() => {
            if (!isAlive) {
                clearInterval(liveCheckInterval);
                socket.terminate();
                propagateDisconnect!(
                    disconnectedDueToTimeout(this.config.connectionTimeout));
                return;
            }
            isAlive = false;
            socket.ping();
        }, this.config.connectionTimeout);

        const gracefulDisconnect = () => {
            clearInterval(liveCheckInterval);
            clearInterval(pingInterval);
            propagateDisconnect!(getOk());
        };

        this.webSocketServer.on('close', gracefulDisconnect);
        socket.on('close', gracefulDisconnect);

        return awaitableDisconnect;
    }

    private async handleClientMessage(
        bidiStreams: BidiStreamMap<Context>,
        serverStreams: ServerStreamMap<Context>,
        mutableContext: Context,
        rawMessage: WebSocket.Data,
        socket: WebSocket
    ): Promise<void> {
        const message = RpcServer.parseRawMessage(socket, rawMessage);
        if (!has(message)) {
            return;
        }

        if (this.maybeHandleSetClientContext(mutableContext, socket, message)) {
            return;
        }

        if (!await this.serverValidation(socket, message, mutableContext)) {
            return;
        }

        if (await this.maybeHandleBidiStreamMessage(bidiStreams, message, mutableContext, socket)) {
            return;
        }

        if (await this.maybeHandleServerStreamMessage(serverStreams, message, mutableContext, socket)) {
            return;
        }

        if (await this.maybeExecuteRequestReply(socket, message, mutableContext)) {
            return;
        }

        await RpcServer.sendUnknownMethod(socket, message);
    }

    private maybeHandleSetClientContext(
        mutableContext: Context,
        socket: WebSocket,
        message: WebSocketClientMessage<JsonValue>
    ): boolean {
        if (message.method !== CLIENT_CONTEXT_METHOD) {
            return false;
        }

        const receivedContext = message.args;
        if (!isA<HttpContext>(receivedContext)) {
            RpcServer.send(socket,
                {
                    requestId: message.requestId,
                    reply: invalidContextT().toSerializedReply(),
                });
            return true;
        }

        this.mergeContext(mutableContext, receivedContext as Context);
        RpcServer.sendOk(socket, message);
        return true;
    }

    private mergeContext(
        target: Context,
        src: Context
    ) {
        Object.assign(target, src);
        for (const headerName in target.requestHeaders) {
            (target.requestHeaders as any)[headerName.toLocaleLowerCase()] =
                target.requestHeaders[headerName];
        }
        for (const headerName in target.responseHeaders) {
            (target.responseHeaders as any)[headerName.toLocaleLowerCase()] =
                target.responseHeaders[headerName];
        }
    }

    private async serverValidation(
        socket: WebSocket,
        message: WebSocketClientMessage<JsonValue>,
        mutableContext: Context
    ): Promise<boolean> {
        const serverValidation = await this.runServerMiddleware(
            message.args,
            mutableContext
        );
        if (serverValidation.notOk()) {
            RpcServer.send(socket, {
                requestId: message.requestId,
                reply: serverValidation.toSerializedReply(),
            });
            return false;
        }
        return true;
    }

    private async maybeExecuteRequestReply(
        socket: WebSocket,
        message: WebSocketClientMessage<JsonValue>,
        mutableContext: Context
    ): Promise<boolean> {
        const service = this.config.requestReplyList.find(
            service => service.getName() === message?.method);
        if (!has(service)) {
            return false;
        }
        const reply = await this.runServiceMiddlewareAndExecuteRequestReply(service,
            message.args, mutableContext as Context);
        RpcServer.send(socket,
            {
                requestId: message.requestId,
                reply: reply.toSerializedReply(),
            });
        return true;
    }

    /**
     * Handles complete and initialization messages to server streams.
     * @return {@code true} only if {@param message} is a server stream message.
     */
    private async maybeHandleServerStreamMessage(
        serverStreams: ServerStreamMap<Context>,
        message: WebSocketClientMessage<JsonValue>,
        mutableContext: Context,
        socket: WebSocket,
    ): Promise<boolean> {
        if (!await this.maybeCreateServerStream(serverStreams, message, mutableContext, socket)) {
            return false;
        }

        const stream: AnyServerStreamService<Context> = serverStreams[message.requestId]!;

        if (message.method === COMPLETE_METHOD) {
            stream.complete(Reply.createFromSerializedReply(message.args as SerializedReply));
            delete serverStreams[message.requestId];
            return true;
        }

        return true;
    }

    /**
     * @return {@code true} only if {@param message} is a bidi stream message.
     */
    private async maybeHandleBidiStreamMessage(
        bidiStreams: BidiStreamMap<Context>,
        message: WebSocketClientMessage<JsonValue>,
        mutableContext: Context,
        socket: WebSocket,
    ): Promise<boolean> {
        if (!has(bidiStreams[message.requestId])) {
            return this.maybeCreateBidiStream(bidiStreams, message, socket, mutableContext);
        }

        const stream: AnyBidiStreamService<Context> = bidiStreams[message.requestId]!;

        if (message.method === COMPLETE_METHOD) {
            stream.complete(Reply.createFromSerializedReply(message.args as SerializedReply));
            delete bidiStreams[message.requestId];
            return true;
        }

        const validation = await stream.runMiddleware(message.args, mutableContext);
        if (validation.notOk()) {
            stream.complete(validation);
        } else {
            stream.onMessage(message.args, mutableContext);
        }
        return true;
    }

    /**
     * @return {@code true} only if {@param message} is a bidi stream message.
     */
    private async maybeCreateBidiStream(
        bidiStreams: BidiStreamMap<Context>,
        message: WebSocketClientMessage<JsonValue>,
        socket: WebSocket,
        mutableContext: Context,
    ): Promise<boolean> {
        const stream = this.config.bidiStreamFactoryList.find(
            streamFactory => streamFactory.getName() === message.method)?.create();
        if (!has(stream)) {
            return false;
        }

        await this.wireStreamToServer(message, bidiStreams, stream, socket);

        const validation = await stream.runMiddleware(message.args, mutableContext);
        if (validation.notOk()) {
            stream.complete(validation);
        } else {
            await stream.init(mutableContext);
            stream.onMessage(message.args, mutableContext);
        }
        return true;
    }

    private async wireStreamToServer<ClientMessageT, ServerMessageT>(
        message: WebSocketClientMessage<ClientMessageT>,
        streamMap: BidiStreamMap<Context> | ServerStreamMap<Context>,
        stream: AnyBidiStreamService<Context> | AnyServerStreamService<Context>,
        socket: WebSocket
    ): Promise<void> {
        streamMap[message.requestId] = stream;
        stream.setCompleter((end: Reply) => {
            delete streamMap[message.requestId];
            RpcServer.send(socket,
                {
                    requestId: message.requestId, reply: end.toSerializedReply(), complete: true,
                });
            stream.onCompleted(end);
        });
        stream.setSender((toSend: ServerMessageT) => {
            RpcServer.send(socket,
                {
                    requestId: message.requestId,
                    reply: toSend !== null && typeof toSend === 'object' && 'toSerializedReply' in toSend ?
                        (toSend as any).toSerializedReply() : toSend,
                });
        });
    }

    private async runServiceMiddlewareAndExecuteRequestReply(
        service: AnyRequestReplyService<Context>,
        rawArgs: JsonValue,
        mutableContext: Context
    ): UnknownReplyPromise {
        const serviceValidation = await service.runMiddleware(rawArgs, mutableContext);
        if (serviceValidation.notOk()) {
            return serviceValidation;
        }
        try {
            return await service.execute(rawArgs, mutableContext);
        } catch (e) {
            Reply.createFromError(e).log(LogTag.Notify);
            mutableContext.httpStatusCode = HttpStatusCode.InternalServerError;
            return errStatus('Internal server error.');
        }
    }

    private async runServerMiddleware(
        args: any,
        context: Context
    ): ReplyPromise<never> {
        for (const middleware of this.config.middlewareQueue) {
            let validation;
            try {
                validation = await middleware.execute(args, context);
            } catch (e) {
                return Reply.createFromError(e);
            }
            if (!validation.ok()) {
                return validation;
            }
        }
        return getOk();
    }

    /**
     * @return {@code true} only if {@param message} is a message directed at a bound server stream.
     */
    private async maybeCreateServerStream(
        serverStreams: ServerStreamMap<Context>,
        message: WebSocketClientMessage<JsonValue>,
        mutableContext: Context,
        socket: WebSocket
    ): Promise<boolean> {
        if (has(serverStreams[message.requestId])) {
            // Do nothing for duplicate request id's.
            return true;
        }

        const stream = this.config.serverStreamFactoryList.find(
            streamFactory => streamFactory.getName() === message.method)?.create();
        if (!has(stream)) {
            return false;
        }

        await this.wireStreamToServer(message, serverStreams, stream, socket);

        const validation = await stream.runMiddleware(message.args, mutableContext);
        if (validation.notOk()) {
            stream.complete(validation);
        } else {
            stream.start(message.args, mutableContext);
        }
        return true;
    }
}
