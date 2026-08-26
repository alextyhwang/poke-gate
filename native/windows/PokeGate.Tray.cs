using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Threading;
using System.Windows.Forms;

internal static class TrayProgram
{
    [STAThread]
    public static int Main(string[] args)
    {
        bool created;
        using (Mutex mutex = new Mutex(true, @"Local\PokeGate.Tray", out created))
        {
            if (!created) return 0;

            string logsDirectory = null;
            int benchmarkSeconds = 0;
            for (int index = 0; index < args.Length; index++)
            {
                if (args[index] == "--logs" && index + 1 < args.Length) logsDirectory = args[++index];
                else if (args[index] == "--benchmark-seconds" && index + 1 < args.Length)
                    Int32.TryParse(args[++index], out benchmarkSeconds);
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new PokeGateTrayContext(logsDirectory, benchmarkSeconds));
            GC.KeepAlive(mutex);
            return 0;
        }
    }
}

internal sealed class PokeGateTrayContext : ApplicationContext
{
    private const string TaskName = "Poke Gate";
    private readonly NotifyIcon notifyIcon;
    private readonly ToolStripMenuItem statusItem;
    private readonly string logsDirectory;
    private readonly System.Windows.Forms.Timer benchmarkTimer;

    public PokeGateTrayContext(string logsDirectory, int benchmarkSeconds)
    {
        this.logsDirectory = logsDirectory;
        statusItem = new ToolStripMenuItem("Checking status...") { Enabled = false };
        ContextMenuStrip menu = new ContextMenuStrip();
        menu.Items.Add(statusItem);
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Start gateway", null, delegate { RunSchtasks("/Run"); UpdateStatus(); });
        menu.Items.Add("Stop gateway", null, delegate { RunSchtasks("/End"); UpdateStatus(); });
        menu.Items.Add("Open logs", null, delegate { OpenLogs(); });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit tray", null, delegate { ExitThread(); });
        menu.Opening += delegate { UpdateStatus(); };

        notifyIcon = new NotifyIcon
        {
            Icon = SystemIcons.Application,
            Text = "Poke Gate",
            ContextMenuStrip = menu,
            Visible = true
        };
        notifyIcon.DoubleClick += delegate { OpenLogs(); };
        UpdateStatus();

        if (benchmarkSeconds > 0)
        {
            benchmarkTimer = new System.Windows.Forms.Timer();
            benchmarkTimer.Interval = benchmarkSeconds * 1000;
            benchmarkTimer.Tick += delegate { benchmarkTimer.Stop(); ExitThread(); };
            benchmarkTimer.Start();
        }
    }

    private void UpdateStatus()
    {
        bool running = QueryTaskRunning();
        statusItem.Text = running ? "Gateway: running" : "Gateway: stopped";
        notifyIcon.Text = running ? "Poke Gate - running" : "Poke Gate - stopped";
    }

    private static bool QueryTaskRunning()
    {
        try
        {
            ProcessStartInfo startInfo = SchtasksStartInfo("/Query");
            startInfo.RedirectStandardOutput = true;
            using (Process process = Process.Start(startInfo))
            {
                string output = process.StandardOutput.ReadToEnd();
                process.WaitForExit(3000);
                return process.ExitCode == 0 && output.IndexOf("Running", StringComparison.OrdinalIgnoreCase) >= 0;
            }
        }
        catch { return false; }
    }

    private static void RunSchtasks(string action)
    {
        try
        {
            using (Process process = Process.Start(SchtasksStartInfo(action))) process.WaitForExit(5000);
        }
        catch (Exception error)
        {
            MessageBox.Show(error.Message, "Poke Gate", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static ProcessStartInfo SchtasksStartInfo(string action)
    {
        string executable = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "schtasks.exe");
        return new ProcessStartInfo(executable, action + " /TN \"" + TaskName + "\"")
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            WindowStyle = ProcessWindowStyle.Hidden
        };
    }

    private void OpenLogs()
    {
        if (String.IsNullOrWhiteSpace(logsDirectory) || !Directory.Exists(logsDirectory)) return;
        Process.Start(new ProcessStartInfo("explorer.exe", "\"" + logsDirectory + "\"") { UseShellExecute = true });
    }

    protected override void ExitThreadCore()
    {
        if (notifyIcon != null)
        {
            notifyIcon.Visible = false;
            notifyIcon.Dispose();
        }
        if (benchmarkTimer != null) benchmarkTimer.Dispose();
        base.ExitThreadCore();
    }
}
