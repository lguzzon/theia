/*
 * Copyright (C) 2017 TypeFox and others.
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 */

import * as paths from 'path';
import * as fs from 'fs-extra';
import * as touch from 'touch';
import { injectable, inject, optional } from "inversify";
import URI from "../../application/common/uri";
import { FileUri } from "../../application/node";
import { FileStat, FileSystem } from "../common/filesystem";

type MvOptions = { mkdirp?: boolean, clobber?: boolean, limit?: number };

const trash: (paths: Iterable<string>) => Promise<void> = require("trash");
const mv: (sourcePath: string, targetPath: string, options?: MvOptions, cb?: (error: NodeJS.ErrnoException) => void) => void = require("mv");

@injectable()
export class FileSystemNodeOptions {
    encoding: string;
    recursive: boolean;
    overwrite: boolean;
    moveToTrash: true;

    public static default: FileSystemNodeOptions = {
        encoding: "utf8",
        overwrite: false,
        recursive: true,
        moveToTrash: true
    }
}

@injectable()
export class FileSystemNode implements FileSystem {

    constructor(
        @inject(FileSystemNodeOptions) @optional() protected readonly options: FileSystemNodeOptions = FileSystemNodeOptions.default
    ) { }

    getFileStat(uriAsString: string): Promise<FileStat> {
        const uri = new URI(uriAsString);
        return new Promise<FileStat>((resolve, reject) => {
            const stat = this.doGetStat(uri, 1);
            if (!stat) {
                return reject(new Error(`Cannot find file under the given URI. URI: ${uri}.`));
            }
            resolve(stat);
        });
    }

    exists(uri: string): Promise<boolean> {
        const path = FileUri.fsPath(new URI(uri));
        return Promise.resolve(fs.existsSync(path));
    }

    resolveContent(uri: string, options?: { encoding?: string }): Promise<{ stat: FileStat, content: string }> {
        return new Promise<{ stat: FileStat, content: string }>((resolve, reject) => {
            const _uri = new URI(uri);
            const stat = this.doGetStat(_uri, 0);
            if (!stat) {
                return reject(new Error(`Cannot find file under the given URI. URI: ${uri}.`));
            }
            if (stat.isDirectory) {
                return reject(new Error(`Cannot resolve the content of a directory. URI: ${uri}.`));
            }
            const encoding = this.doGetEncoding(options);
            fs.readFile(FileUri.fsPath(_uri), encoding, (error, content) => {
                if (error) {
                    return reject(error);
                }
                resolve({ stat, content });
            });
        });
    }

    setContent(file: FileStat, content: string, options?: { encoding?: string }): Promise<FileStat> {
        return new Promise<FileStat>((resolve, reject) => {
            const _uri = new URI(file.uri);
            const stat = this.doGetStat(_uri, 0);
            if (!stat) {
                return reject(new Error(`Cannot find file under the given URI. URI: ${file.uri}.`));
            }
            if (stat.isDirectory) {
                return reject(new Error(`Cannot set the content of a directory. URI: ${file.uri}.`));
            }
            if (stat.lastModification !== file.lastModification) {
                return reject(new Error(`File is out of sync. URI: ${file.uri}. Expected timestamp: ${stat.lastModification}. Actual timestamp: ${file.lastModification}.`));
            }
            if (stat.size !== file.size) {
                return reject(new Error(`File is out of sync. URI: ${file.uri}. Expected size: ${stat.size}. Actual size: ${file.size}.`));
            }
            const encoding = this.doGetEncoding(options);
            fs.writeFile(FileUri.fsPath(_uri), content, { encoding }, error => {
                if (error) {
                    return reject(error);
                }
                try {
                    resolve(this.doGetStat(_uri, 1));
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    move(sourceUri: string, targetUri: string, options?: { overwrite?: boolean }): Promise<FileStat> {
        return new Promise<FileStat>((resolve, reject) => {
            const _sourceUri = new URI(sourceUri);
            const sourceStat = this.doGetStat(_sourceUri, 1);
            if (!sourceStat) {
                return reject(new Error(`File does not exist under ${sourceUri}.`));
            }
            const _targetUri = new URI(targetUri);
            const overwrite = this.doGetOverwrite(options);
            const targetStat = this.doGetStat(_targetUri, 1);
            if (targetStat && !overwrite) {
                return reject(new Error(`File already exist under the \'${targetUri}\' target location. Did you set the \'overwrite\' flag to true?`));
            }

            // Different types. Files <-> Directory.
            if (targetStat && sourceStat.isDirectory !== targetStat.isDirectory) {
                const label: (stat: FileStat) => string = (stat) => stat.isDirectory ? "directory" : "file";
                const message = `Cannot move a ${label(sourceStat)} to an existing ${label(targetStat)} location. Source URI: ${sourceUri}. Target URI: ${targetUri}.`;
                return reject(new Error(message))
            }

            // Handling special Windows case when source and target resources are empty folders.
            // Source should be deleted and target should be touched.
            if (targetStat && targetStat.isDirectory && sourceStat.isDirectory && !targetStat.hasChildren && !sourceStat.hasChildren) {
                // The value should be a Unix timestamp in seconds.
                // For example, `Date.now()` returns milliseconds, so it should be divided by `1000` before passing it in.
                const now = Date.now() / 1000;
                fs.utimes(FileUri.fsPath(_targetUri), now, now, (error) => {
                    if (error) {
                        return reject(error);
                    }
                    fs.rmdir(FileUri.fsPath(_sourceUri), (error) => {
                        if (error) {
                            return reject(error);
                        }
                        resolve(this.doGetStat(_targetUri, 1));
                    });
                });
            } else if (targetStat && targetStat.isDirectory && sourceStat.isDirectory && !targetStat.hasChildren && sourceStat.hasChildren) {
                // Copy source to target, since target is empty. Then wipe the source content.
                this.copy(sourceUri, targetUri, { overwrite: true }).then(stat => {
                    this.delete(sourceUri).then(() => {
                        return resolve(stat);
                    });
                }).catch(error => {
                    reject(error);
                });
            } else {
                mv(FileUri.fsPath(_sourceUri), FileUri.fsPath(_targetUri), { mkdirp: true }, (error) => {
                    if (error) {
                        return reject(error);
                    }
                    resolve(this.doGetStat(_targetUri, 1));
                });
            }
        });
    }

    copy(sourceUri: string, targetUri: string, options?: { overwrite?: boolean, recursive?: boolean }): Promise<FileStat> {
        return new Promise<FileStat>((resolve, reject) => {
            const _sourceUri = new URI(sourceUri);
            const sourceStat = this.doGetStat(_sourceUri, 0);
            if (!sourceStat) {
                return reject(new Error(`File does not exist under ${sourceUri}.`));
            }
            const overwrite = this.doGetOverwrite(options);
            const _targetUri = new URI(targetUri);
            const targetStat = this.doGetStat(_targetUri, 0);
            if (targetStat && !overwrite) {
                return reject(new Error(`File already exist under the \'${targetUri}\' target location. Did you set the \'overwrite\' flag to true?`));
            }
            fs.copy(FileUri.fsPath(_sourceUri), FileUri.fsPath(_targetUri), error => {
                if (error) {
                    return reject(error);
                }
                return resolve(this.doGetStat(_targetUri, 1));
            });
        });
    }

    createFile(uri: string, options?: { content?: string, encoding?: string }): Promise<FileStat> {
        return new Promise<FileStat>((resolve, reject) => {
            const _uri = new URI(uri);
            const stat = this.doGetStat(_uri, 0);
            if (stat) {
                return reject(new Error(`Error occurred while creating the file. File already exists at ${uri}.`));
            }
            const parentUri = _uri.parent;
            const doCreateFile = () => {
                const content = this.doGetContent(options);
                const encoding = this.doGetEncoding(options);
                fs.writeFile(FileUri.fsPath(_uri), content, { encoding }, error => {
                    if (error) {
                        return reject(error);
                    }
                    resolve(this.doGetStat(_uri, 1));
                });
            }
            if (!this.doGetStat(parentUri, 0)) {
                fs.mkdirs(FileUri.fsPath(parentUri), error => {
                    if (error) {
                        return reject(error);
                    }
                    doCreateFile();
                });
            } else {
                doCreateFile();
            }
        });
    }

    createFolder(uri: string): Promise<FileStat> {
        return new Promise<FileStat>((resolve, reject) => {
            const _uri = new URI(uri);
            const stat = this.doGetStat(_uri, 0);
            if (stat) {
                return reject(new Error(`Error occurred while creating the directory. File already exists at ${uri}.`));
            }
            fs.mkdirs(FileUri.fsPath(_uri), error => {
                if (error) {
                    return reject(error);
                }
                resolve(this.doGetStat(_uri, 1));
            });
        });
    }

    touchFile(uri: string): Promise<FileStat> {
        return new Promise<FileStat>((resolve, reject) => {
            const _uri = new URI(uri);
            const stat = this.doGetStat(_uri, 0);
            if (!stat) {
                this.createFile(uri).then(stat => {
                    resolve(stat);
                });
            } else {
                touch(FileUri.fsPath(_uri), (error: any) => {
                    if (error) {
                        return reject(error);
                    }
                    resolve(this.doGetStat(_uri, 1));
                });
            }
        });
    }

    delete(uri: string, options?: { moveToTrash?: boolean }): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            const _uri = new URI(uri);
            const stat = this.doGetStat(_uri, 0);
            if (!stat) {
                return reject(new Error(`File does not exist under ${uri}.`));
            }
            // Windows 10.
            // Deleting an empty directory triggers `error` instead of `unlinkDir`.
            // https://github.com/paulmillr/chokidar/issues/566
            const moveToTrash = this.doGetMoveToTrash(options);
            if (moveToTrash) {
                resolve(trash([FileUri.fsPath(_uri)]));
            } else {
                fs.remove(FileUri.fsPath(_uri), error => {
                    if (error) {
                        return reject(error);
                    }
                    resolve();
                });
            }
        });
    }

    getEncoding(uri: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const _uri = new URI(uri);
            const stat = this.doGetStat(_uri, 0);
            if (!stat) {
                return reject(new Error(`File does not exist under ${uri}.`));
            }
            if (stat.isDirectory) {
                return reject(new Error(`Cannot get the encoding of a director. URI: ${uri}.`));
            }
            return resolve(this.options.encoding);
        });
    }

    getRoots(): Promise<FileStat[]> {
        const cwdRoot = paths.parse(process.cwd()).root;
        const rootUri = FileUri.create(cwdRoot);
        const root = this.doGetStat(rootUri, 1);
        if (root) {
            return Promise.resolve([root]);
        }
        console.error(`Cannot locate the file system root under ${rootUri}.`);
        return Promise.resolve([]);
    }

    dispose(): void {
    }

    protected doGetStat(uri: URI, depth: number): FileStat | undefined {
        const path = FileUri.fsPath(uri);
        try {
            const stats = fs.statSync(path);
            if (stats.isDirectory()) {
                return this.doCreateDirectoryStat(uri, path, stats, depth);
            }
            return this.doCreateFileStat(uri, stats);
        } catch (error) {
            if (isErrnoException(error)) {
                if (error.code === "ENOENT" || error.code === "EACCES") {
                    return undefined;
                }
            }
            throw error;
        }
    }

    protected doCreateFileStat(uri: URI, stat: fs.Stats): FileStat {
        return {
            uri: uri.toString(),
            lastModification: stat.mtime.getTime(),
            isDirectory: false,
            size: stat.size
        };
    }

    protected doCreateDirectoryStat(uri: URI, path: string, stat: fs.Stats, depth: number): FileStat {
        const files = fs.readdirSync(path);
        const hasChildren = files.length > 0;
        const children = hasChildren && depth > 0 ? this.doGetChildren(uri, files, depth) : undefined;
        return {
            uri: uri.toString(),
            lastModification: stat.mtime.getTime(),
            isDirectory: true,
            hasChildren,
            children
        };
    }

    protected doGetChildren(uri: URI, files: string[], depth: number): FileStat[] {
        const children = [];
        for (const file of files) {
            const childUri = uri.resolve(file);
            const child = this.doGetStat(childUri, depth - 1);
            if (child) {
                children.push(child);
            }
        }
        return children;
    }

    protected doGetEncoding(option?: { encoding?: string }): string {
        return option && typeof (option.encoding) !== "undefined"
            ? option.encoding
            : this.options.encoding;
    }

    protected doGetOverwrite(option?: { overwrite?: boolean }): boolean {
        return option && typeof (option.overwrite) !== "undefined"
            ? option.overwrite
            : this.options.overwrite;
    }

    protected doGetRecursive(option?: { recursive?: boolean }): boolean {
        return option && typeof (option.recursive) !== "undefined"
            ? option.recursive
            : this.options.recursive;
    }

    protected doGetMoveToTrash(option?: { moveToTrash?: boolean }): boolean {
        return option && typeof (option.moveToTrash) !== "undefined"
            ? option.moveToTrash
            : this.options.moveToTrash;
    }

    protected doGetContent(option?: { content?: string }): string {
        return (option && option.content) || "";
    }

}

function isErrnoException(error: any | NodeJS.ErrnoException): error is NodeJS.ErrnoException {
    return (<NodeJS.ErrnoException>error).code !== undefined && (<NodeJS.ErrnoException>error).errno !== undefined;
}