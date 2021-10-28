import {has} from '@0cfg/utils-common/lib/has';
import {hasAll} from '@0cfg/utils-common/lib/hasAll';
import {deepCopy} from '@0cfg/utils-common/lib/deepCopy';
import {log, LogTag} from './log';

/**
 * Atomic, serializable and human readable status code for use in both internal services and API's.
 * Note that this is intended to be kept simple and should not be extended.
 */
export enum Status {
    Ok = 'Ok', Error = 'Error'
}

/**
 * Generic reply type serialization for use in both internal services and API's.
 * Note that this is not intended to be used directly, and doing so is considered bad practice.
 * Reviewers should point to use {@link Reply} instead.
 * Note that this is in fact used for JSON data exchange over the internet, but should be converted to
 * {@link Reply} using {@link Reply.createFromSerializedReply} before using in code.
 * Note that this is intended to be kept simple and changes should be evaluated wisely.
 */
export type SerializedReply<T = never, S extends Status = Status> = {
    readonly code: S;
    readonly errMessage: S extends Status.Ok ? never : string;
    readonly data: S extends Status.Ok ? T : never;
}

/**
 * Thrown when a user tries to access the error message of a reply with {@link StatusCode.OK}.
 */
export class UnexpectedOkError extends Error {
    public constructor() {
        super('A reply with StatusCode.OK does not store an errorMessage. Did you mean .getValue()?');
    }
}

/**
 * Thrown when a user tries to access the value of a reply with {@link StatusCode.ERROR}.
 */
export class UnexpectedNotOkError extends Error {
    public constructor(errorMessage: string) {
        super(
            'A reply with StatusCode.ERROR is not intended to hold any data. Did you mean .getMessage()?' +
            `Error message: ${errorMessage}`
        );
    }
}

/**
 * Generic reply type for use in both internal services and API's.
 * Note that this is intended to be kept simple and changes should be evaluated wisely.
 * Note that replies MUST be converted to JSON for security reasons, using {@link toSerializedReply} before passing to
 * external APIs to remove stack traces.
 *
 * The Reply does not implement {@link SerializedReply}.
 * Instead, it holds a serialized reply privately and grants access to it using helper methods.
 */
export class Reply<T = never, S extends Status = Status> {

    /**
     * Never change to public, use {@link Reply.getOk} instead.
     */
    private static readonly OK: Reply<never, Status.Ok> = new Reply({
        code: Status.Ok,
    } as SerializedReply<never, Status.Ok>, undefined);
    private readonly serializedReply: SerializedReply<T, S>
    private readonly stack: S extends Status.Ok ? undefined : string;
    private static logAsJson : boolean = false;
    public static setLogAsJson (logAsJson : boolean):void {
        Reply.logAsJson = logAsJson;
    }

    /**
     * Never change to public, use composition (wrap a Reply) instead of inheritance.
     * Note that it is considered good practice to create your own dedicated Reply instance constant and reuse it in
     * your code.
     * Extending this class all over the codebase would make this hard to maintain.
     *
     * @param reply The source wherefrom this reply is copied.
     * @param stack A string containing stack trace information
     */
    private constructor(reply: SerializedReply<T, S>, stack: S extends Status.Ok ? undefined : string) {
        this.serializedReply = reply;
        this.stack = stack;
    }

    /**
     * Note that this will evaluate all replies passed to this method in order to collect the error messages, even if
     * {@link Reply.ok} was false for an entry early in the parameter list (unlike the && operator).
     *
     * @return Returns {@link Reply.getOk} if {@link Reply.ok} is true for all replies passed to this method.
     * Will return a new {@link Reply} with an error message merged from all error messages of the replies for
     * which {@link Reply.ok} is false, if {@link Reply.ok} is false for at least one of the replies.
     */
    public static all(...replies: Reply<unknown>[]): Reply {
        for (const reply of replies) {
            if (reply.notOk()) {
                return Reply.collectErrors(...replies);
            }
        }
        return Reply.getOk();
    }

    /**
     * Returns {@link Reply.getOk} if {@link Reply.ok} is true for at least one of the replies passed to this
     * method. Will return a new {@link Reply} with an error message merged all error messages of the replies if
     * {@link Reply.ok} is false for all replies. Note that this
     * will evaluate only the entries in the parameter list before {@link .ok} was true for the first time
     * (like the || operator).
     */
    public static any(...replies: Reply<unknown>[]): Reply<string> {
        for (const reply of replies) {
            if (reply.ok()) {
                return Reply.getOk();
            }
        }
        return Reply.collectErrors(...replies);
    }

    /**
     * Returns a new {@link Reply} with {@link Status.OK}.
     * This is intended to be used as a data return type for both internal services and API'S when the execution was
     * successful.
     * @param data {T} wrapped by the Reply.
     */
    public static okReply<T>(data?: T): Reply<T, Status.Ok> {
        return new Reply({
            code: Status.Ok,
            data: data,
        } as SerializedReply<T, Status.Ok>, undefined);
    }

    /**
     * Returns a new {@link Reply} with {@link Status.OK}.
     * This is intended to be used as a message return type for API'S when the execution was
     * successful.
     * Note that internal services should use {@link Reply.getOK) which does not require an invocation of 'new'.
     * @param message {string} wrapped by the Reply.
     */
    public static okStatus(message: string): Reply<string, Status.Ok> {
        return new Reply({
            code: Status.Ok,
            data: message,
        } as SerializedReply<string, Status.Ok>, undefined);
    }

    /**
     * Returns a new {@link Reply} with {@link Status.ERROR}.
     * This is intended to be used as a message return type for both in${name}: ternal services and API'S when the
     * execution encountered an error.
     *
     * @param message A string wrapped by the Reply or an error object {@link Error}.
     * @param stack An optional stack trace to be set in the returned status.
     *      If an error object is passed as the {@param message} then the stack in the error is used.
     *      If a string is passed as the {@param message} and this param is not set, the current call stack is used.
     */
    public static errStatus(message: string | Error,
                            stack?: (typeof message) extends Error ? never : string): Reply<never, Status.Error> {
        if (typeof message === 'string') {
            return new Reply<never, Status.Error>(
                {
                    code: Status.Error,
                    errMessage: message,
                } as SerializedReply<never, Status.Error>,
                (stack) ?? new Error().stack as string
            );
        } else {
            return Reply.createFromError(message);
        }
    }

    /**
     * Returns a reference to an instance of {@link Reply} with {@link Status.OK}.
     * This is intended to be used as a simple return type for internal services when the execution was
     * successful.
     * Note that API's should use {@link Reply.okStatus) which does include a message to describe the successful
     * execution.
     */
    public static getOk(): Reply<never, Status.Ok> {
        return Reply.OK;
    }

    /**
     * Returns a new {@link Reply} with data equivalent to the reply of type {@link SerializedReply} passed to this
     * method. Note that you should never work with {@link SerializedReply} directly but always switch to {@link Reply}
     * as soon as possible. Note that this does return {@link Reply.getUnparseable} if the provided reply could
     * not be parsed.
     */
    public static createFromSerializedReply<T, S extends Status = Status>(reply: SerializedReply<T, S>): Reply<T> {
        if (!has(reply) || !has(reply.code) && (!has(reply.data) || !has(reply.errMessage))) {
            return Reply.getUnparseable();
        }
        return new Reply<T>(reply, reply.code === Status.Ok ? undefined : new Error().stack);
    }

    /**
     * Returns a new {@link Reply} with data equivalent to the {@link Error} passed to this
     * method.
     * This is intended to be used to transform an {@link Error} from an external source to a {@link Reply} with
     * {@link Status.ERROR}.
     * Note that you should not throw {@link Errors} in control flow and possible runtime behaviour (See:
     * https://wiki.c2.com/?DontUseExceptionsForFlowControl) of owned code (including illegal user interactions,
     * service calls etc.) and avoid them in general for performance reasons. Note that this does return
     * {@link Reply.getUnparseable} if the provided error could not be parsed.
     */
    public static createFromError(err: Error): Reply<never, Status.Error> {
        if (!has(err) || !hasAll(err.message, err.stack)) {
            return Reply.getUnparseable();
        }
        return new Reply(
            {
                code: Status.Error,
                errMessage: (err.name !== 'Error' ? `(${err.name}) ` : '') + err.message,
            } as SerializedReply<never, Status.Error>,
            err.stack ?? new Error().stack as string
        );
    }

    private static collectErrors(...replies: Reply<unknown>[]): Reply {
        const failedReplys = replies.filter(reply => reply.notOk());
        const message = failedReplys.map(reply => reply.getErrorMessage()).join('\n');
        const stack = failedReplys.map(reply => reply.stack).join('\n\n');
        return failedReplys.length === 0 ? Reply.getOk() : Reply.errStatus(message, stack);
    }

    private static getUnparseable(): Reply<never, Status.Error> {
        return Reply.errStatus('The reply could not be parsed.');
    }

    /**
     * True if {@link code} equal to {@link Status.OK}.
     *
     * Don't negate this functions return value. Use {@link notOk} instead.
     */
    public ok(): this is Reply<T, Status.Ok> {
        return this.serializedReply.code === Status.Ok;
    }

    /**
     * True if {@link code} equal to {@link Status.ERROR}.
     *
     * Sometimes you want to return your instance of  {@code Reply<B>} in a function
     * but while generating the data for that instance of {@code Reply<B>} an instance of {@code Reply<A>} is
     * generated that is not ok ({@link ok} returns false). Now you want to return that instance of {@code
     * Reply<A>} as an instance of {@code Reply<never>} instead of returning your instance of
     * {@code Reply<B>}.
     * {@link Reply.notOk} is type guarded to enable you to do exactly that.
     *
     */
    public notOk(): this is Reply<never, Status.Error> {
        return !this.ok();
    }

    /**
     * Convert {@link Reply} to {@link SerializedReply} to reduce overhead and remove stack traces (which could possibly
     * contain sensitive information) when sent over the internet.
     * Note that {@link SerializedReply} is not intended to be
     * used in code and should always be converted to {@link Reply} using {@link Reply.createFromSerializedReply}.
     */
    public toSerializedReply(): SerializedReply<T> {
        return deepCopy(this.serializedReply);
    }

    /**
     * Returns {@link Reply.getOk} if {@link Reply.ok} is true for this and otherReply.
     * Will return a new {@link Reply} with an error message merged from all error messages of the replies for
     * which {@link Reply.ok} is false, if {@link Reply.ok} is false for at least one of the replies. Note
     * that this will evaluate this first, then otherReply but always evaluates this and otherReply to collect
     * the error messages, even if {@link Reply.ok} was false for this (unlike the && operator).
     */
    public and(otherReply: Reply<unknown>): Reply<string> {
        return Reply.all(this, otherReply);
    }

    /**
     * Returns {@link Reply.getOk} if {@link Reply.ok} is true for this or otherReply.
     * Will return a new {@link Reply} with an error message merged from both error messages of this and
     * otherReply if {@link Reply.ok} is false for both this and otherReply. Note that this will evaluate
     * this
     * first, then otherReply but only evaluates this if {@link Reply.ok} is true for this (like the ||
     * operator).
     */
    public or(otherReply: Reply<unknown>): Reply<string> {
        return Reply.any(this, otherReply);
    }

    /**
     * Returns the stored error message if {@link code} equals {@link Status.ERROR}.
     * @throws an Error if this is misused ({@link code} actually equals {@link Status.OK}).
     */
    public getErrorMessage(): S extends Status.Ok ? never : string {
        if (this.ok()) {
            throw new UnexpectedOkError();
        }
        return this.serializedReply.errMessage;
    }

    /**
     * Returns the stored data if {@link code} equals {@link Status.OK}.
     * @throws an Error if this is misused ({@link code} actually equals {@link Status.ERROR}).
     */
    public getValue(): S extends Status.Ok ? T : never {
        if (this.notOk()) {
            throw new UnexpectedNotOkError(this.serializedReply.errMessage);

        }
        return this.serializedReply.data;
    }

    /**
     * @return This {@link Reply.getValue} if {@link Reply.ok} evaluates to true. {@param alternativeData} if
     *     not.
     */
    public orElse(alternativeData: T): T {
        if (this.ok()) {
            return this.getValue();
        } else {
            return alternativeData;
        }
    }

    /**
     * Formats and prints the current timestamp, data (if {@link code} equals {@link Status.OK}) or errorMessage
     * (if {@link code} equals {@link Status.ERROR}) and stack trace (if present and {@link code} equals
     * {@link Status.ERROR}).
     * This is intended to be the primary way of production logging for internal services. Log
     * writing and log file management/retention should not be done inside the application, but rather handled by
     * external tools which run the application. NEVER log user passwords or privacy sensitive information.
     */
    public log(...tags: LogTag[]): this {
        if (this.notOk()) {
            log(this.stack, Reply.logAsJson, this.getErrorMessage(), Status.Error, ...tags);
            // eslint-disable-next-line no-console
            Reply.logAsJson && console.log(this.stack)
        } else {
            log(this.stack, Reply.logAsJson, JSON.stringify(this.getValue()), this.serializedReply.code, ...tags);
        }
        return this;
    }

    /**
     * Only does {@link log} if {@link code} equals {@link Status.ERROR}.
     */
    public logIfError(): this {
        if (this.notOk()) {
            this.log();
        }
        return this;
    }

    /**
     * Only throws a new error with the stack and message of this
     * reply if {@link code} equals {@link Status.ERROR}.
     */
    public throwIfError(): Reply<T, Status.Ok> {
        if (this.ok()) {
            return this;
        } else {
            const err = new Error(this.getErrorMessage());
            if (has(this.stack)) {
                err.stack = this.stack;
            }
            throw err;
        }
    }
}

export type UnknownReply = Reply<unknown>;
export type ReplyPromise<T> = Promise<Reply<T>>;
export type UnknownReplyPromise = ReplyPromise<unknown>;
export const all = Reply.all;
export const any = Reply.any;
export const okStatus = Reply.okStatus;
export const errStatus = Reply.errStatus;
export const okReply = Reply.okReply;
export const getOk = Reply.getOk;
