import {Status} from './Reply';

export enum LogTag {
    Default = 'Default',
    Notify = 'Notify'
}

/**
 * Formats and prints a message, a status code, and the current timestamp to the command line.
 */
export const log = (stack: string | undefined, logAsJson: boolean, message: string, code: Status = Status.Ok, ...tags: LogTag[]): string => {
    if (logAsJson) {
        return logJson(stack, message, code, ...tags); 
    }
    return logPlain(message, code, ...tags);
};

export const logPlain = (message: string, code: Status = Status.Ok, ...tags: LogTag[]): string => {
    const tagsString = tags.map(tag => `, #${tag}`).join('');
    const logString: string = `[${code}, ${new Date().toISOString()}${tagsString}]: ${message}`;
    // eslint-disable-next-line no-console
    console.log(logString);
    return logString;
};

export const logJson = (stack: string | undefined, message: string, code: Status = Status.Ok, ...tags: LogTag[]): string => {
    const logJson = JSON.stringify({date: new Date().toISOString(), stack, message, code, tags})
    // eslint-disable-next-line no-console
    console.log(logJson);
    return logJson;
};
