// 由 macOS 自带的 osascript 执行；路径仅从环境变量读取，不作为脚本源码。
ObjC.import('AppKit');
ObjC.import('Foundation');

function run() {
  const app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  app.activateIgnoringOtherApps(true);
  const panel = $.NSOpenPanel.openPanel;
  panel.title = 'Mechanics：选择文件夹';
  panel.prompt = '选择文件夹';
  panel.canChooseDirectories = true;
  panel.canChooseFiles = false;
  panel.allowsMultipleSelection = false;
  panel.canCreateDirectories = false;
  const initialPath = ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey('GAME_GRAPH_PICKER_INITIAL_PATH'));
  if (initialPath) panel.directoryURL = $.NSURL.fileURLWithPath(initialPath);
  const response = panel.runModal;
  if (response === $.NSModalResponseCancel) return JSON.stringify({ cancelled: true });
  if (response !== $.NSModalResponseOK) throw new Error('系统文件夹选择器返回未知状态：' + response);
  return JSON.stringify({ cancelled: false, path: ObjC.unwrap(panel.URL.path) });
}
