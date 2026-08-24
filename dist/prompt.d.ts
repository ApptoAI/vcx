export declare class PromptCancelledError extends Error {
    name: string;
    constructor();
}
export declare function promptSecret(label: string): Promise<string>;
export declare function confirm(message: string): Promise<boolean>;
export declare function readStdin(): Promise<string>;
//# sourceMappingURL=prompt.d.ts.map