export interface VercelRunOptions {
    globalConfig?: string;
    capture?: boolean;
    env?: NodeJS.ProcessEnv;
    /** Working directory for Vercel. Defaults to the current directory. */
    cwd?: string;
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