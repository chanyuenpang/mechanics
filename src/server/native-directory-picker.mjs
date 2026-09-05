import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ContractError } from '../domain/validate.mjs';

// 固定脚本通过编码参数传入；用户路径只经环境变量传递，绝不拼接成命令。
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -Path $env:GAME_GRAPH_PICKER_HELPER
$selectedDirectory = [GameGraphDirectoryDialog]::Pick($env:GAME_GRAPH_PICKER_INITIAL_PATH, 'Game-Graph：选择文件夹')
if ($null -eq $selectedDirectory) {
  @{ cancelled = $true } | ConvertTo-Json -Compress
} else {
  @{ cancelled = $false; path = $selectedDirectory } | ConvertTo-Json -Compress
}
`;

export function createNativeDirectoryPicker({ platform = process.platform, run = promisify(execFile) } = {}) {
  let controller = null;
  return {
    async pick(body) {
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => key !== 'initialPath')
        || (body.initialPath !== undefined && (typeof body.initialPath !== 'string'
          || body.initialPath.includes('\0') || (body.initialPath !== '' && !isAbsolute(body.initialPath))))) {
        throw new ContractError('DIRECTORY_PICKER_INVALID', '选择文件夹只接受可选的 initialPath 绝对路径');
      }
      if (platform !== 'win32') throw new ContractError('DIRECTORY_PICKER_UNSUPPORTED', '当前原生文件夹选择器仅支持 Windows');
      if (controller) throw new ContractError('DIRECTORY_PICKER_BUSY', '文件夹选择器已经打开，请先完成或取消选择');
      controller = new AbortController();
      try {
        const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
          windowsHide: true, encoding: 'utf8', timeout: 600000, maxBuffer: 65536, signal: controller.signal,
          env: { ...process.env, GAME_GRAPH_PICKER_INITIAL_PATH: body.initialPath ?? '',
            GAME_GRAPH_PICKER_HELPER: fileURLToPath(new URL('./windows-directory-dialog.cs', import.meta.url)) },
        });
        const result = JSON.parse(stdout.trim());
        if (result?.cancelled === true && Object.keys(result).length === 1) return result;
        if (result?.cancelled === false && typeof result.path === 'string' && isAbsolute(result.path)
          && !result.path.includes('\0') && Object.keys(result).length === 2) return result;
        throw new Error('选择器返回了无效的文件夹结果');
      } catch (error) {
        throw new ContractError('DIRECTORY_PICKER_FAILED', 'Windows 文件夹选择器调用失败：' + error.message);
      } finally { controller = null; }
    },
    close() { controller?.abort(); },
  };
}
