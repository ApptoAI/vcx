export interface LinkResult {
    globalDir: string;
    backupDir?: string;
}
/**
 * The directory Vercel CLI reads when no `--global-config` is given.
 * Mirrors `xdg-app-paths` `dataDirs()[0]`, which Vercel uses.
 */
export declare function getVercelGlobalDir(env?: NodeJS.ProcessEnv): string;
/**
 * Point Vercel's global config directory at a profile directory so a plain
 * `vercel` command uses the same account as `vcx`. An existing real directory
 * is moved aside once, never deleted.
 */
export declare function linkVercelGlobalDir(profileDir: string, env?: NodeJS.ProcessEnv): Promise<LinkResult>;
/** Remove the link vcx created. A real directory is left alone. */
export declare function unlinkVercelGlobalDir(env?: NodeJS.ProcessEnv): Promise<string | undefined>;
//# sourceMappingURL=vercel-global.d.ts.map