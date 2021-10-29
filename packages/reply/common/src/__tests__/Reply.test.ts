import {Reply, SerializedReply, Status} from '../ts/Reply';

const message = 'This is a test';
type TestType = { test: string };
const data: TestType = {test: message};
const unparseable = {test: 'bla bla bla'};
const ERR_STATUS: Reply<null> = Reply.errStatus(message);
const ERR_STATUS2: Reply<null> = Reply.errStatus('Das isch en anerer Tescht.');

test('logDoesNotThrow', () => {
    expect(Reply.getOk().log()).toEqual(Reply.getOk());
    expect(Reply.getOk().logIfError()).toEqual(Reply.getOk());
    const errStatus = Reply.errStatus('bla');
    expect(errStatus.logIfError()).toEqual(errStatus);
});

test('jsonLogTest', () => {
    Reply.setLogAsJson(true)
    const consoleSpy = jest.spyOn(console, 'log');
    ERR_STATUS.log(); 
    expect(consoleSpy.mock.calls[0][0]).toMatch(new RegExp(`{\\"date\\":\\"\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?(([+-]\\d\\d:\\d\\d)|Z)?\\",\\"stack\\":\\"[^\\"]*\\",\\"message\\":\\"${message}\\",\\"code\\":\\"[^\"]*\\",\\"tags":\\[\\]}`));
    ERR_STATUS2.log();
    expect(consoleSpy.mock.calls[2][0]).toMatch(new RegExp(`{\\"date\\":\\"\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?(([+-]\\d\\d:\\d\\d)|Z)?\\",\\"stack\\":\\"[^\\"]*\\",\\"message\\":\\"Das isch en anerer Tescht.\\",\\"code\\":\\"[^\"]*\\",\\"tags":\\[\\]}`));
});

test('plainLogTest', () => {
    Reply.setLogAsJson(false)
    const consoleSpy = jest.spyOn(console, 'log');
    ERR_STATUS.log(); 
    expect(consoleSpy.mock.calls[4][0]).toMatch(new RegExp(`\\[Error,\\s\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?(([+-]\\d\\d:\\d\\d)|Z)?\]:\\s${message}`));
    ERR_STATUS2.log(); 
    expect(consoleSpy.mock.calls[5][0]).toMatch(new RegExp(`\\[Error,\\s\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d(\\.\\d+)?(([+-]\\d\\d:\\d\\d)|Z)?\]:\\sDas isch en anerer Tescht.`));
});

test('okAndNotOk', () => {
    expect(Reply.getOk().notOk()).toBeFalsy();
    expect(Reply.getOk().ok()).toBeTruthy();
    expect(Reply.getOk().notOk()).toBeFalsy();
});

test('createDirectly', () => {
    const okStatus = Reply.okStatus(message);
    expect(okStatus.ok()).toBeTruthy();
    expect(okStatus.getValue()).toEqual(message);
    expect(okStatus.getErrorMessage).toThrow();

    const errStatus = Reply.errStatus(message);
    expect(errStatus.notOk()).toBeTruthy();
    expect(errStatus.getValue).toThrow();
    expect(errStatus.getErrorMessage()).toEqual(message);

    const okReply: Reply<TestType> = Reply.okReply<TestType>(data);
    expect(okReply.ok()).toBeTruthy();
    expect(okReply.getValue()).toEqual(data);
    expect(okReply.getErrorMessage).toThrow();
});

test('createFromSerializedReply', () => {
    const okStatusFromSerializedReply: Reply<TestType> = Reply.createFromSerializedReply<TestType>({
        data: data,
        code: Status.Ok,
    } as SerializedReply<TestType, Status.Ok>);
    expect(okStatusFromSerializedReply.ok()).toBeTruthy();
    expect(okStatusFromSerializedReply.getValue()).toEqual(data);
    expect(okStatusFromSerializedReply.getErrorMessage).toThrow();

    const okReplyFromSerializedReply: Reply<TestType> = Reply.createFromSerializedReply<TestType>({
        data: data,
        code: Status.Ok,
    } as SerializedReply<TestType, Status.Ok>);
    expect(okReplyFromSerializedReply.ok()).toBeTruthy();
    expect(okReplyFromSerializedReply.getValue()).toEqual(data);
    expect(okReplyFromSerializedReply.getErrorMessage).toThrow();

    const errStatusFromSerializedReply: Reply<TestType> = Reply.createFromSerializedReply({
        errMessage: message,
        code: Status.Error,
    } as SerializedReply<TestType, Status.Error>);
    expect(errStatusFromSerializedReply.notOk()).toBeTruthy();
    expect(errStatusFromSerializedReply.getValue).toThrow();
    expect(errStatusFromSerializedReply.getErrorMessage()).toEqual(message);

    const unparseableFromSerializedReply: Reply<unknown> =
        Reply.createFromSerializedReply(unparseable as unknown as SerializedReply<unknown>);
    expect(unparseableFromSerializedReply.notOk()).toBeTruthy();
    expect(Reply.createFromSerializedReply(null as any).notOk()).toBeTruthy();
    expect(Reply.createFromSerializedReply('bla' as any).notOk()).toBeTruthy();
});

test('createFromError', () => {
    const errStatusFromError: Reply<TestType> = Reply.createFromError(new Error(message));
    expect(errStatusFromError.notOk()).toBeTruthy();
    expect(errStatusFromError.getValue).toThrow();
    expect(errStatusFromError.getErrorMessage()).toEqual(message);

    const unparseableFromError: Reply<TestType> = Reply.createFromError(unparseable as any as Error);
    expect(unparseableFromError.notOk()).toBeTruthy();
    expect(Reply.createFromError('bla' as any as Error).notOk()).toBeTruthy();
});

test('toSerializedReply', () => {
    const errStatusFromError: Reply<TestType> = Reply.createFromError(new Error(message));
    expect(errStatusFromError.toSerializedReply())
        .toEqual({ // Note that 'stack' is not included
            errMessage: message,
            code: Status.Error,
        });
});

test('all', () => {
    expect(Reply.all(Reply.getOk(), Reply.getOk()).ok()).toBeTruthy();
    expect(Reply.all(Reply.getOk(), ERR_STATUS).ok()).toBeFalsy();
    expect(Reply.all(Reply.getOk(), ERR_STATUS).getErrorMessage().includes(ERR_STATUS.getErrorMessage()))
        .toBeTruthy();
    expect(Reply.all(ERR_STATUS, Reply.getOk()).ok()).toBeFalsy();
    expect(Reply.all(ERR_STATUS, Reply.getOk()).getErrorMessage().includes(ERR_STATUS.getErrorMessage()))
        .toBeTruthy();
    expect(Reply.all(ERR_STATUS, ERR_STATUS2).ok()).toBeFalsy();
    expect(Reply.all(ERR_STATUS, ERR_STATUS2).getErrorMessage().includes(ERR_STATUS.getErrorMessage()))
        .toBeTruthy();
    expect(Reply.all(ERR_STATUS, ERR_STATUS2).getErrorMessage().includes(ERR_STATUS2.getErrorMessage()))
        .toBeTruthy();
});

test('any', () => {
    expect(Reply.any(Reply.getOk(), Reply.getOk()).ok()).toBeTruthy();
    expect(Reply.any(Reply.getOk(), ERR_STATUS).ok()).toBeTruthy();
    expect(Reply.any(ERR_STATUS, Reply.getOk()).ok()).toBeTruthy();
    expect(Reply.any(ERR_STATUS, ERR_STATUS2).ok()).toBeFalsy();
    expect(Reply.any(ERR_STATUS, ERR_STATUS2).getErrorMessage().includes(ERR_STATUS.getErrorMessage()))
        .toBeTruthy();
    expect(Reply.any(ERR_STATUS, ERR_STATUS2).getErrorMessage().includes(ERR_STATUS2.getErrorMessage()))
        .toBeTruthy();
});

test('and', () => {
    expect(Reply.getOk().and(Reply.getOk()).ok()).toBeTruthy();
    expect(Reply.getOk().and(ERR_STATUS).ok()).toBeFalsy();
    expect(Reply.getOk().and(ERR_STATUS).getErrorMessage().includes(ERR_STATUS.getErrorMessage())).toBeTruthy();
    expect(ERR_STATUS.and(Reply.getOk()).ok()).toBeFalsy();
    expect(ERR_STATUS.and(Reply.getOk()).getErrorMessage().includes(ERR_STATUS.getErrorMessage())).toBeTruthy();
    expect(ERR_STATUS.and(ERR_STATUS2).ok()).toBeFalsy();
    expect(ERR_STATUS.and(ERR_STATUS2).getErrorMessage().includes(ERR_STATUS.getErrorMessage())).toBeTruthy();
    expect(ERR_STATUS.and(ERR_STATUS2).getErrorMessage().includes(ERR_STATUS2.getErrorMessage())).toBeTruthy();
});

test('or', () => {
    expect(Reply.getOk().or(Reply.getOk()).ok()).toBeTruthy();
    expect(Reply.getOk().or(ERR_STATUS).ok()).toBeTruthy();
    expect(ERR_STATUS.or(Reply.getOk()).ok()).toBeTruthy();
    expect(ERR_STATUS.or(ERR_STATUS2).ok()).toBeFalsy();
    expect(ERR_STATUS.or(ERR_STATUS2).getErrorMessage().includes(ERR_STATUS.getErrorMessage())).toBeTruthy();
    expect(ERR_STATUS.or(ERR_STATUS2).getErrorMessage().includes(ERR_STATUS2.getErrorMessage())).toBeTruthy();
});

test('usage', () => {
    const someFunc: (hasError: boolean) => Reply<string> = (hasError: boolean) => {
        if (hasError) {
            return Reply.errStatus('This is an error!');
        }
        return Reply.okStatus('This is ok!');
    };

    expect(someFunc(/*hasError=*/ true).ok()).toBeFalsy();
    expect(someFunc(/*hasError=*/ false).getValue()).toEqual('This is ok!');
});

/**
 * Sometimes you want to return your instance of {@code Reply<B>} in a function but while generating the data for
 * that {@code Reply<B>} an instance of {@code Reply<A>} is generated that is not ok ({@link Reply.ok}
 * returns {@code false}). Now you want to return that {@code Reply<A>} as a {@code Reply<never>} instead of
 * returning your {@code Reply<B>}. {@link Reply.notOk} is type guarded to enable exactly that use pattern.
 */
test('properly type guarded', () => {
    type A = { a: number };

    const intermediateResponse: Reply<A> = Reply.errStatus('Im an error');
    // Should compile
    if (intermediateResponse.ok()) {
        expect(() => intermediateResponse.getValue().a).not.toThrow();
    }
    // Should not compile and throw an error.
    if (intermediateResponse.notOk()) {
        // @ts-expect-error
        expect(() => intermediateResponse.getValue().a).toThrow();
    }

    // Should compile
    if (intermediateResponse.notOk()) {
        expect(() => intermediateResponse.getErrorMessage().includes('Error')).not.toThrow();
    }
    // Should not compile and throw an error.
    if (intermediateResponse.ok()) {
        // @ts-expect-error
        expect(() => intermediateResponse.getErrorMessage().includes('Error')).toThrow();
    }
});

test('errReply from error object', () => {
    const name = 'SpecialError';
    const message = 'An error.';
    const stack = 'My stack';

    const error: Error = {name, message, stack};

    const reply = Reply.errStatus(error);
    expect(reply.getErrorMessage()).toBe(`(${name}) ${message}`);
});
