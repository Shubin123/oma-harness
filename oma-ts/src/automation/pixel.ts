/**
 * OMA Pixel-Level Automation - framebuffer capture, click, and key injection.
 *
 * The lowest level of automation. Works with any UI, any app.
 * Approach:
 *   1. Capture the framebuffer (screenshot)
 *   2. Send to vision model for element detection
 *   3. Click or type at computed coordinates
 *   4. Capture again to verify state change
 *
 * Platform support:
 *   - macOS: screencapture + cliclick / AppleScript
 *   - Linux: scrot/grim + xdotool/ydotool
 *   - Windows: PowerShell screen capture + SendKeys
 *
 * When running inside a harness with browser tools (MCP computer_* tools),
 * delegates to those instead of raw commands.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export interface ScreenRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ClickTarget {
  x: number;
  y: number;
  button?: 'left' | 'right' | 'middle';
  clicks?: number;
}

export interface TypeAction {
  text: string;
  delayMs?: number;
}

export type McpDelegate = (action: string, opts?: Record<string, unknown>) => unknown;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

export class PixelAutomator {
  /**
   * Platform-aware pixel-level automation.
   *
   * For use outside of browser/MCP contexts.
   * Inside those contexts, prefer the higher-level tools.
   */
  private system: string;
  private delegate?: McpDelegate;

  constructor(mcpDelegate?: McpDelegate) {
    this.system = process.platform; // 'darwin', 'linux', 'win32'
    this.delegate = mcpDelegate;
  }

  /** Capture framebuffer to a temp PNG. Returns path. */
  capture(region?: ScreenRegion): string {
    if (this.delegate) {
      return this.delegate('screenshot', { region }) as string;
    }

    const capturePath = path.join(
      os.tmpdir(),
      `oma_capture_${Date.now()}.png`,
    );

    if (this.system === 'darwin') {
      const args = ['-x']; // -x = no sound
      if (region) {
        args.push('-R', `${region.x},${region.y},${region.width},${region.height}`);
      }
      args.push(capturePath);
      execSync(`screencapture ${args.join(' ')}`, { timeout: 10_000 });
    } else if (this.system === 'linux') {
      if (region) {
        const geom = `${region.width}x${region.height}+${region.x}+${region.y}`;
        execSync(`grim -g "${geom}" "${capturePath}"`, { timeout: 10_000 });
      } else {
        execSync(`grim "${capturePath}"`, { timeout: 10_000 });
      }
    } else if (this.system === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms;` +
        `$s = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds;` +
        `$b = New-Object Drawing.Bitmap($s.Width,$s.Height);` +
        `$g = [Drawing.Graphics]::FromImage($b);` +
        `$g.CopyFromScreen($s.Location,[Drawing.Point]::Empty,$s.Size);` +
        `$b.Save('${capturePath}')`;
      execSync(`powershell -Command "${ps}"`, { timeout: 10_000 });
    } else {
      throw new Error(`unsupported platform: ${this.system}`);
    }

    return capturePath;
  }

  /** Click at pixel coordinates. */
  click(target: ClickTarget): void {
    if (this.delegate) {
      this.delegate('click', {
        x: target.x,
        y: target.y,
        button: target.button ?? 'left',
        clicks: target.clicks ?? 1,
      });
      return;
    }

    const clicks = target.clicks ?? 1;

    if (this.system === 'darwin') {
      const action = target.button === 'right' ? 'rc' : 'c';
      for (let i = 0; i < clicks; i++) {
        execSync(`cliclick ${action}:${target.x},${target.y}`, { timeout: 5000 });
      }
    } else if (this.system === 'linux') {
      const btnMap: Record<string, string> = { left: '1', right: '3', middle: '2' };
      const btn = btnMap[target.button ?? 'left'] ?? '1';
      execSync(
        `xdotool mousemove ${target.x} ${target.y} click --repeat ${clicks} ${btn}`,
        { timeout: 5000 },
      );
    }
  }

  /** Type text with inter-keystroke delay. */
  typeText(action: TypeAction): void {
    if (this.delegate) {
      this.delegate('type', { text: action.text });
      return;
    }

    if (this.system === 'darwin') {
      execSync(`cliclick t:"${action.text.replace(/"/g, '\\"')}"`, { timeout: 30_000 });
    } else if (this.system === 'linux') {
      const delay = action.delayMs ?? 50;
      execSync(
        `xdotool type --delay ${delay} "${action.text.replace(/"/g, '\\"')}"`,
        { timeout: 30_000 },
      );
    }
  }

  /** Press a key combination (e.g., 'cmd+c', 'ctrl+shift+t'). */
  key(combo: string): void {
    if (this.delegate) {
      this.delegate('key', { combo });
      return;
    }

    if (this.system === 'darwin') {
      execSync(`cliclick kp:${combo}`, { timeout: 5000 });
    } else if (this.system === 'linux') {
      execSync(`xdotool key ${combo}`, { timeout: 5000 });
    }
  }

  /**
   * Wait until the framebuffer changes in the given region.
   * Returns true if a change was detected, false on timeout.
   */
  async waitForChange(
    region?: ScreenRegion,
    timeoutS = 10.0,
    pollIntervalS = 0.5,
  ): Promise<boolean> {
    const baseline = this.capture(region);
    const baselineData = fs.readFileSync(baseline);
    const baselineHash = crypto.createHash('sha256').update(baselineData).digest('hex');

    const deadline = Date.now() + timeoutS * 1000;
    while (Date.now() < deadline) {
      await sleep(pollIntervalS * 1000);
      const current = this.capture(region);
      const currentData = fs.readFileSync(current);
      const currentHash = crypto.createHash('sha256').update(currentData).digest('hex');
      if (currentHash !== baselineHash) return true;
    }

    return false;
  }
}
