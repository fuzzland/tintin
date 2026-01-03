export interface CloudWorkspace {
  id: string;
  rootPath: string;
}

export interface CloudUploadFile {
  path: string;
  content: string | Buffer;
  mode?: string;
}

export interface CloudProvider {
  id: string;
  createWorkspace(opts: { prefix?: string }): Promise<CloudWorkspace>;
  uploadFiles(workspace: CloudWorkspace, files: CloudUploadFile[]): Promise<void>;
  runCommands(opts: { workspace: CloudWorkspace; cwd: string; commands: string[]; env?: Record<string, string> }): Promise<void>;
  snapshotWorkspace(workspace: CloudWorkspace, label: string): Promise<string>;
  pullDiff(opts: { workspace: CloudWorkspace; cwd: string }): Promise<{ diff: string; summary: string }>;
  terminateWorkspace(workspace: CloudWorkspace): Promise<void>;
}
