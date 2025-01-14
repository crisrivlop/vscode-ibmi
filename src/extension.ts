// The module 'vscode' contains the VS Code extensibility API
import { ExtensionContext, commands, languages, window, workspace } from "vscode";

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed

import { CustomUI } from "./webviews/CustomUI";
import { instance, loadAllofExtension } from './instantiate';
import { onCodeForIBMiConfigurationChange } from "./config/Configuration";
import { Tools } from "./api/Tools";
import * as Debug from './debug';
import { parseErrors } from "./api/errors/parser";
import { DeployTools } from "./filesystems/local/deployTools";
import { Deployment } from "./filesystems/local/deployment";
import { CopyToImport } from "./api/components/copyToImport";
import { CustomQSh } from "./components/cqsh";
import { GetMemberInfo } from "./api/components/getMemberInfo";
import { GetNewLibl } from "./api/components/getNewLibl";
import { extensionComponentRegistry } from "./api/components/manager";
import { IFSFS } from "./filesystems/ifsFs";
import { LocalActionCompletionItemProvider } from "./languages/actions/completion";
import * as Sandbox from "./sandbox";
import { initialise } from "./testing";
import { CodeForIBMi, ConnectionData } from "./typings";
import { initializeConnectionBrowser } from "./views/ConnectionBrowser";
import { LibraryListProvider } from "./views/LibraryListView";
import { ProfilesView } from "./views/ProfilesView";
import { initializeDebugBrowser } from "./views/debugView";
import { HelpView } from "./views/helpView";
import { initializeIFSBrowser } from "./views/ifsBrowser";
import { initializeObjectBrowser } from "./views/objectBrowser";
import { initializeSearchView } from "./views/searchView";
import { SettingsUI } from "./webviews/settings";
import { registerActionTools } from "./views/actions";
import IBMi from "./api/IBMi";

export async function activate(context: ExtensionContext): Promise<CodeForIBMi> {
  // Use the console to output diagnostic information (console.log) and errors (console.error)
  // This line of code will only be executed once when your extension is activated
  console.log(`Congratulations, your extension "code-for-ibmi" is now active!`);

  await loadAllofExtension(context);

  const updateLastConnectionAndServerCache = () => {
    const connections = IBMi.connectionManager.getAll();
    const lastConnections = (IBMi.GlobalStorage.getLastConnections() || []).filter(lc => connections.find(c => c.name === lc.name));
    IBMi.GlobalStorage.setLastConnections(lastConnections);
    commands.executeCommand(`setContext`, `code-for-ibmi:hasPreviousConnection`, lastConnections.length > 0);
    IBMi.GlobalStorage.deleteStaleServerSettingsCache(connections);
    commands.executeCommand(`code-for-ibmi.refreshConnections`);
  };

  SettingsUI.init(context);
  initializeConnectionBrowser(context);
  initializeObjectBrowser(context)
  initializeIFSBrowser(context);
  initializeDebugBrowser(context);
  initializeSearchView(context);

  context.subscriptions.push(
    window.registerTreeDataProvider(
      `helpView`,
      new HelpView(context)
    ),
    window.registerTreeDataProvider(
      `libraryListView`,
      new LibraryListProvider(context)
    ),
    window.registerTreeDataProvider(
      `profilesView`,
      new ProfilesView(context)
    ),
    
    onCodeForIBMiConfigurationChange("connections", updateLastConnectionAndServerCache),
    onCodeForIBMiConfigurationChange("connectionSettings", async () => {
      const connection = instance.getConnection();
      if (connection) {
        const config = instance.getConfig();
        if (config) {
          Object.assign(config, (await IBMi.connectionManager.load(config.name)));
        }
      }
    }),
    workspace.registerFileSystemProvider(`streamfile`, new IFSFS(), {
      isCaseSensitive: false
    }),
    languages.registerCompletionItemProvider({ language: 'json', pattern: "**/.vscode/actions.json" }, new LocalActionCompletionItemProvider(), "&")
  );

  registerActionTools(context);
  Debug.initialize(context);
  Deployment.initialize(context);
  updateLastConnectionAndServerCache();

  Sandbox.handleStartup();
  Sandbox.registerUriHandler(context);

  console.log(`Developer environment: ${process.env.DEV}`);
  if (process.env.DEV) {
    // Run tests if not in production build
    initialise(context);
  }

  instance.subscribe(
    context,
    'connected',
    `Refresh views`,
    () => {
      commands.executeCommand("code-for-ibmi.refreshObjectBrowser");
      commands.executeCommand("code-for-ibmi.refreshLibraryListView");
      commands.executeCommand("code-for-ibmi.refreshIFSBrowser");
      commands.executeCommand("code-for-ibmi.refreshProfileView");
    });

  extensionComponentRegistry.registerComponent(context, new CustomQSh());
  extensionComponentRegistry.registerComponent(context, new GetNewLibl);
  extensionComponentRegistry.registerComponent(context, new GetMemberInfo());
  extensionComponentRegistry.registerComponent(context, new CopyToImport());

  return {
    instance, customUI: () => new CustomUI(),
    deployTools: DeployTools,
    evfeventParser: parseErrors,
    tools: Tools,
    componentRegistry: extensionComponentRegistry
  };
}

// this method is called when your extension is deactivated
export async function deactivate() {
  await commands.executeCommand(`code-for-ibmi.disconnect`, true);
}
