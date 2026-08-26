import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync } from "node:fs";
import { extname, join } from "node:path";
import { tmpdir, platform } from "node:os";
import { isLoggedIn, login } from "poke";
import { sendToWebhook } from "./webhook.js";

import { resolveUserPath } from "./platform-paths.js";

const WINDOWS_CAPTURE_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)
  $bitmap.Save($env:POKE_GATE_SCREENSHOT_DEST, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $graphics.Dispose()
  $bitmap.Dispose()
}
`;

export function captureScreenshot(options = {}) {
  const currentPlatform = options.platform ?? platform();
  const temporary = !options.path;
  const dest = options.path
    ? resolveUserPath(options.path, options)
    : join(tmpdir(), `poke-gate-screenshot-${Date.now()}.png`);

  if (extname(dest).toLowerCase() !== ".png") {
    throw new Error("Screenshot destination must use a .png extension.");
  }

  if (currentPlatform === "darwin") {
    execFileSync("/usr/sbin/screencapture", ["-x", dest], { stdio: "pipe" });
  } else if (currentPlatform === "win32") {
    execFileSync(
      options.powershellPath || process.env.POKE_GATE_POWERSHELL_PATH || "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_CAPTURE_SCRIPT],
      {
        stdio: "pipe",
        windowsHide: true,
        env: { ...process.env, POKE_GATE_SCREENSHOT_DEST: dest },
      },
    );
  } else {
    throw new Error(`Screenshots are not supported on ${currentPlatform}.`);
  }

  const png = readFileSync(dest);
  return { path: dest, png, temporary };
}

export async function takeScreenshot() {

  if (!isLoggedIn()) {
    console.log("Signing in to Poke...");
    await login();
  }

  console.log("Capturing screenshot...");
  let screenshot;
  try {
    screenshot = captureScreenshot();
  } catch (error) {
    const hint = platform() === "darwin"
      ? " Grant Screen Recording permission in System Settings > Privacy & Security > Screen Recording."
      : " Make sure Poke Gate is running in the signed-in user's interactive desktop session.";
    console.error(`Screenshot failed: ${error.message}.${hint}`);
    process.exit(1);
  }

  const { png } = screenshot;
  const base64 = png.toString("base64");

  console.log(`Screenshot captured (${(png.length / 1024).toFixed(0)} KB). Sending to Poke...`);

  try {
    await sendToWebhook(
      `Here is a screenshot of my screen right now. Reply me with the image.\n\n\`\`\`\ndata:image/png;base64,${base64}\n\`\`\``
    );
    console.log("Screenshot sent to Poke.");
  } finally {
    if (screenshot.temporary) {
      try { unlinkSync(screenshot.path); } catch {}
    }
  }
}

export { WINDOWS_CAPTURE_SCRIPT };
