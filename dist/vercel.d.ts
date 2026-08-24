export interface VercelRunOptions {
    globalConfig?: string;
    capture?: boolean;
    env?: NodeJS.ProcessEnv;
}
export interface VercelRunResult {
    code: number;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    missingBinary: boolean;
}
export declare function runVercel(args: string[], options?: VercelRunOptions): Promise<VercelRunResult>;
export declare function findReservedVercelOption(args: string[]): string | undefined;
//# sourceMappingURL=vercel.d.ts.map