import { ParsedUrlQueryInput, parse, stringify } from "querystring";
import vscode, { FilePermission, FileSystemError } from "vscode";
import { onCodeForIBMiConfigurationChange } from "../../api/Configuration";
import { Tools } from "../../api/Tools";
import { instance } from "../../instantiate";
import { IBMiMember, QsysFsOptions } from "../../typings";
import { FileStatCache } from "../fileStatCache";
import { ExtendedIBMiContent } from "./extendedContent";
import { SourceDateHandler } from "./sourceDateHandler";

export function getMemberUri(member: IBMiMember, options?: QsysFsOptions) {
    return getUriFromPath(`${member.asp ? `${member.asp}/` : ``}${member.library}/${member.file}/${member.name}.${member.extension}`, options);
}

export function getUriFromPath(path: string, options?: QsysFsOptions) {
    const query = stringify(options as ParsedUrlQueryInput);
    if (path.startsWith(`/`)) {
        //IFS path
        return vscode.Uri.parse(path).with({ scheme: `streamfile`, path, query });
    } else {
        //QSYS path
        return vscode.Uri.parse(path).with({ scheme: `member`, path: `/${path}`, query });
    }
}

export function getFilePermission(uri: vscode.Uri): FilePermission | undefined {
    const fsOptions = parseFSOptions(uri);
    if (instance.getConfig()?.readOnlyMode || fsOptions.readonly) {
        return FilePermission.Readonly;
    }
}

export function parseFSOptions(uri: vscode.Uri): QsysFsOptions {
    const parameters = parse(uri.query);
    return {
        readonly: parameters.readonly === `true`
    };
}

export function isProtectedFilter(filter?: string): boolean {
    return filter && instance.getConfig()?.objectFilters.find(f => f.name === filter)?.protected || false;
}

export class QSysFS implements vscode.FileSystemProvider {
    private readonly statCache = new FileStatCache();
    private readonly sourceDateHandler: SourceDateHandler;
    private readonly extendedContent: ExtendedIBMiContent;
    private extendedMemberSupport = false;
    private emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
    onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.emitter.event;

    constructor(context: vscode.ExtensionContext) {
        this.sourceDateHandler = new SourceDateHandler(context);
        this.extendedContent = new ExtendedIBMiContent(this.sourceDateHandler);

        context.subscriptions.push(
            onCodeForIBMiConfigurationChange(["connectionSettings", "showDateSearchButton"], () => this.updateMemberSupport()),
            vscode.workspace.onDidCloseTextDocument((doc) => this.statCache.clear(doc.uri)),
            vscode.commands.registerCommand("code-for-ibmi.clearQSYSStats", (uri?: vscode.Uri | string) => this.statCache.clear(uri))
        );

        instance.onEvent("connected", () => this.updateMemberSupport());
        instance.onEvent("disconnected", () => {
            this.updateMemberSupport();
            this.statCache.clear();
        });
    }

    private updateMemberSupport() {
        this.extendedMemberSupport = false
        const connection = instance.getConnection();
        const config = connection?.config;

        if (connection && config?.enableSourceDates) {
            if (connection.sqlRunnerAvailable()) {
                this.extendedMemberSupport = true;
                this.sourceDateHandler.changeSourceDateMode(config.sourceDateMode);
                const ccsidDetail = connection.getEncoding();
                if (ccsidDetail.invalid) {
                    vscode.window.showWarningMessage(`Source date support is enabled, but CCSID is 65535. If you encounter problems with source date support, please disable it in the settings.`);
                }
            } else {
                vscode.window.showErrorMessage(`Source date support is enabled, but the remote system does not support SQL. Source date support will be disabled.`);
            }
        }

        this.sourceDateHandler.setEnabled(this.extendedMemberSupport);
    }

    async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
        const path = uri.path;
        const type = path.split(`/`).length > 3 ? vscode.FileType.File : vscode.FileType.Directory;
        let currentStat = this.statCache.get(path);
        if (currentStat === undefined) {
            const content = instance.getContent();
            if (content) {
                const attributes = await content.getAttributes(Tools.parseQSysPath(path), "CREATE_TIME", "MODIFY_TIME", "DATA_SIZE");
                if (attributes) {
                    currentStat = {
                        ctime: Tools.parseAttrDate(String(attributes.CREATE_TIME)),
                        mtime: Tools.parseAttrDate(String(attributes.MODIFY_TIME)),
                        size: Number(attributes.DATA_SIZE),
                        type,
                        permissions: getFilePermission(uri)
                    }
                }

                if (!currentStat) {
                    this.statCache.set(path, null);
                    throw FileSystemError.FileNotFound(uri);
                }
            }
            else {
                currentStat = {
                    ctime: 0,
                    mtime: 0,
                    size: 0,
                    type,
                    permissions: getFilePermission(uri)
                }
            }
            this.statCache.set(path, currentStat);
        }
        else if (currentStat === null) {
            throw FileSystemError.FileNotFound(uri);
        }
        return currentStat;
    }

    async readFile(uri: vscode.Uri, retrying?: boolean): Promise<Uint8Array> {
        const contentApi = instance.getContent();
        const connection = instance.getConnection();
        if (connection && contentApi) {
            const { asp, library, file, name: member } = connection.parserMemberPath(uri.path);
            const memberContent = this.extendedMemberSupport ?
                await this.extendedContent.downloadMemberContentWithDates(asp, library, file, member) :
                await contentApi.downloadMemberContent(asp, library, file, member);
            if (memberContent !== undefined) {
                return new Uint8Array(Buffer.from(memberContent, `utf8`));
            }
            else {
                throw new Error(`Couldn't read ${uri}; check IBM i connection.`);
            }
        }
        else {
            if (retrying) {
                throw new Error("Not connected to IBM i");
            }
            else {
                await vscode.commands.executeCommand(`code-for-ibmi.connectToPrevious`);
                return this.readFile(uri, true);
            }
        }
    }

    async writeFile(uri: vscode.Uri, content: Uint8Array, options: { readonly create: boolean; readonly overwrite: boolean; }) {
        this.statCache.clear(uri);
        const contentApi = instance.getContent();
        const connection = instance.getConnection();
        if (connection && contentApi) {
            const { asp, library, file, name: member } = connection.parserMemberPath(uri.path);
            this.extendedMemberSupport ?
                await this.extendedContent.uploadMemberContentWithDates(asp, library, file, member, content.toString()) :
                await contentApi.uploadMemberContent(asp, library, file, member, content);
        }
        else {
            throw new Error("Not connected to IBM i");
        }
    }

    rename(oldUri: vscode.Uri, newUri: vscode.Uri, options: { readonly overwrite: boolean; }): void | Thenable<void> {
        console.log({ oldUri, newUri, options });
        this.statCache.clear(oldUri.path);
        this.statCache.clear(newUri.path);
    }

    watch(uri: vscode.Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[]; }): vscode.Disposable {
        return { dispose: () => { } };
    }

    readDirectory(uri: vscode.Uri): [string, vscode.FileType][] | Thenable<[string, vscode.FileType][]> {
        throw new Error("Method not implemented.");
    }

    createDirectory(uri: vscode.Uri): void | Thenable<void> {
        throw new Error("Method not implemented.");
    }

    delete(uri: vscode.Uri, options: { readonly recursive: boolean; }): void | Thenable<void> {
        this.statCache.clear(uri.path);
        throw new Error("Method not implemented.");
    }
}