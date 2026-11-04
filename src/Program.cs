using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: AssemblyTitle("YM Studio")]
[assembly: AssemblyProduct("YM Studio")]
[assembly: AssemblyDescription("Неофициальный клиент Яндекс Музыки")]
[assembly: AssemblyVersion("1.0.2.0")]
[assembly: AssemblyFileVersion("1.0.2.0")]
[assembly: AssemblyInformationalVersion("1.0")] // SignPath requires the same product version in every build

namespace YMStudio
{
    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern uint RegisterWindowMessage(string name);
        [DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr w, IntPtr l);

        // A window hidden in the tray has no MainWindowHandle, so the second launch broadcasts instead.
        public static readonly uint ShowMessage = RegisterWindowMessage("YMStudio.ShowWindow");

        [STAThread]
        static void Main()
        {
            bool first;
            using (var mutex = new Mutex(true, "YMStudio.SingleInstance", out first))
            {
                if (!first)
                {
                    PostMessage(new IntPtr(0xFFFF), ShowMessage, IntPtr.Zero, IntPtr.Zero);
                    return;
                }
                try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch (EntryPointNotFoundException) { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new MainForm());
            }
        }
    }

    // Reads the Wallpaper Engine library. Video files can be played directly; scenes and web wallpapers are
    // drawn by Wallpaper Engine alone, so only their previews are usable. Its -control switches had no effect
    // on a running instance when tested, so nothing here relies on them.
    class WallpaperEngine
    {
        const long MaxPreviewBytes = 8 * 1024 * 1024;
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        readonly string exe;

        public WallpaperEngine()
        {
            try
            {
                using (var key = Registry.CurrentUser.OpenSubKey(@"Software\WallpaperEngine"))
                {
                    var path = key == null ? null : key.GetValue("installPath") as string;
                    if (!string.IsNullOrEmpty(path) && File.Exists(path)) exe = path;
                }
            }
            catch (System.Security.SecurityException) { }
        }

        public bool Installed { get { return exe != null; } }
        string ConfigPath { get { return Path.Combine(Path.GetDirectoryName(exe), "config.json"); } }

        public static bool Running
        {
            get { return Process.GetProcessesByName("wallpaper64").Length + Process.GetProcessesByName("wallpaper32").Length > 0; }
        }

        public DateTime ConfigTime
        {
            get { return Installed && File.Exists(ConfigPath) ? File.GetLastWriteTimeUtc(ConfigPath) : DateTime.MinValue; }
        }

        static object Dig(object node, params string[] path)
        {
            foreach (var key in path)
            {
                var map = node as Dictionary<string, object>;
                if (map == null || !map.TryGetValue(key, out node)) return null;
            }
            return node;
        }

        Dictionary<string, object> ReadConfig()
        {
            try { return json.Deserialize<Dictionary<string, object>>(File.ReadAllText(ConfigPath)); }
            catch (IOException) { return null; }
            catch (UnauthorizedAccessException) { return null; }
            catch (ArgumentException) { return null; }
            catch (InvalidOperationException) { return null; }
        }

        string SelectedFile()
        {
            var config = ReadConfig();
            if (config == null) return null;
            foreach (var user in config.Values)
            {
                var monitors = Dig(user, "general", "wallpaperconfig", "selectedwallpapers") as Dictionary<string, object>;
                if (monitors == null) continue;
                foreach (var monitor in monitors.Values)
                {
                    var file = Dig(monitor, "file") as string;
                    if (!string.IsNullOrEmpty(file)) return file;
                }
            }
            return null;
        }

        public bool PausesWhenMaximized
        {
            get
            {
                var config = ReadConfig();
                if (config == null) return false;
                foreach (var user in config.Values)
                {
                    var mode = Dig(user, "general", "user", "playbackmaximized") as string;
                    if (mode != null) return mode != "run";
                }
                return false;
            }
        }

        public Dictionary<string, object> Describe()
        {
            var info = new Dictionary<string, object> {
                { "installed", Installed }, { "running", Running }, { "pausesMaximized", false },
                { "title", "" }, { "kind", "" }, { "preview", "" }
            };
            if (!Installed) return info;
            info["pausesMaximized"] = PausesWhenMaximized;
            var file = SelectedFile();
            if (file == null) return info;
            try
            {
                var dir = Path.GetDirectoryName(file.Replace('/', Path.DirectorySeparatorChar));
                var project = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(Path.Combine(dir, "project.json")));
                info["title"] = project.ContainsKey("title") ? project["title"] as string ?? "" : "";
                info["kind"] = project.ContainsKey("type") ? (project["type"] as string ?? "").ToLowerInvariant() : "";
                var previewName = project.ContainsKey("preview") ? project["preview"] as string : null;
                if (!string.IsNullOrEmpty(previewName))
                {
                    var preview = new FileInfo(Path.Combine(dir, Path.GetFileName(previewName)));
                    if (preview.Exists && preview.Length <= MaxPreviewBytes)
                    {
                        var ext = preview.Extension.TrimStart('.').ToLowerInvariant();
                        var mime = ext == "gif" ? "image/gif" : ext == "png" ? "image/png" : "image/jpeg";
                        info["preview"] = "data:" + mime + ";base64," + Convert.ToBase64String(File.ReadAllBytes(preview.FullName));
                    }
                }
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
            catch (InvalidOperationException) { }
            return info;
        }

        // Only ids from this table can be served, so the page can never ask for an arbitrary file.
        readonly Dictionary<string, string[]> videos = new Dictionary<string, string[]>();

        public List<Dictionary<string, object>> ListVideos()
        {
            var list = new List<Dictionary<string, object>>();
            videos.Clear();
            if (!Installed) return list;
            var home = Path.GetDirectoryName(exe);
            var roots = new[] {
                Path.GetFullPath(Path.Combine(home, "..", "..", "workshop", "content", "431960")),
                Path.Combine(home, "projects", "myprojects"),
                Path.Combine(home, "projects", "defaultprojects")
            };
            foreach (var root in roots)
            {
                if (!Directory.Exists(root)) continue;
                foreach (var dir in Directory.GetDirectories(root))
                {
                    try
                    {
                        var path = Path.Combine(dir, "project.json");
                        if (!File.Exists(path)) continue;
                        var project = json.Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
                        var name = project.ContainsKey("file") ? project["file"] as string : null;
                        if (string.IsNullOrEmpty(name)) continue;
                        var kind = project.ContainsKey("type") ? (project["type"] as string ?? "").ToLowerInvariant() : "";
                        if (kind == "" && name.EndsWith(".json", StringComparison.OrdinalIgnoreCase)) kind = "scene";
                        if (kind != "video" && kind != "scene" && kind != "web") continue;
                        var video = "";
                        if (kind == "video")
                        {
                            video = Path.Combine(dir, Path.GetFileName(name));
                            var type = ContentType(video);
                            if (type == null || !type.StartsWith("video/") || !File.Exists(video)) continue;
                        }
                        var previewName = project.ContainsKey("preview") ? project["preview"] as string : null;
                        var preview = string.IsNullOrEmpty(previewName) ? "" : Path.Combine(dir, Path.GetFileName(previewName));
                        var id = Path.GetFileName(dir);
                        videos[id] = new[] { video, preview, dir };
                        list.Add(new Dictionary<string, object> {
                            { "id", id },
                            { "kind", kind },
                            { "title", project.ContainsKey("title") ? project["title"] as string ?? id : id },
                            { "preview", File.Exists(preview) }
                        });
                    }
                    catch (IOException) { }
                    catch (UnauthorizedAccessException) { }
                    catch (ArgumentException) { }
                    catch (InvalidOperationException) { }
                }
            }
            return list;
        }

        public string FileFor(string kind, string id)
        {
            string[] entry;
            if (!videos.TryGetValue(id, out entry)) return null;
            return kind == "video" ? entry[0] : kind == "preview" ? entry[1] : null;
        }

        public static string ContentType(string file)
        {
            switch (Path.GetExtension(file).ToLowerInvariant())
            {
                case ".mp4": case ".m4v": return "video/mp4";
                case ".webm": return "video/webm";
                case ".jpg": case ".jpeg": return "image/jpeg";
                case ".png": return "image/png";
                case ".gif": return "image/gif";
                default: return null;
            }
        }

    }

    class MainForm : Form
    {
        const string StartUrl = "https://music.yandex.ru/";
        const int WM_HOTKEY = 0x0312;
        const uint MOD_NOREPEAT = 0x4000;
        const int FirstHotkeyId = 100;
        const long RangeChunk = 4 * 1024 * 1024;

        [DllImport("user32.dll")] static extern bool RegisterHotKey(IntPtr hwnd, int id, uint mods, uint vk);
        [DllImport("user32.dll")] static extern bool UnregisterHotKey(IntPtr hwnd, int id);
        [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
        [DllImport("dwmapi.dll")] static extern int DwmEnableBlurBehindWindow(IntPtr hwnd, ref BlurBehind blur);
        [DllImport("gdi32.dll")] static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);
        [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);

        [StructLayout(LayoutKind.Sequential)]
        struct BlurBehind { public uint Flags; public bool Enable; public IntPtr Region; public bool TransitionOnMaximized; }

        readonly WebView2 web = new WebView2();
        readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        readonly WallpaperEngine engine = new WallpaperEngine();
        readonly System.Windows.Forms.Timer engineTimer = new System.Windows.Forms.Timer { Interval = 3000 };
        readonly Dictionary<int, string> hotkeys = new Dictionary<int, string>();
        readonly string dataDir;
        readonly string windowFile;
        readonly Size minNormal = new Size(820, 560);
        NotifyIcon tray;
        CoreWebView2Environment webEnvironment;
        bool mini, pinned, seeThrough, closeToTray, exiting, fullscreen, engineRunning;
        double zoom = 1;
        DateTime engineStamp;
        Rectangle savedBounds;
        FormWindowState savedState;
        FormWindowState fullscreenState;

        public MainForm()
        {
            var overrideDir = Environment.GetEnvironmentVariable("YMSTUDIO_DATA");
            dataDir = string.IsNullOrEmpty(overrideDir)
                ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YMStudio")
                : overrideDir;
            Directory.CreateDirectory(dataDir);
            windowFile = Path.Combine(dataDir, "window.txt");

            Text = "YM Studio";
            BackColor = Color.Black;
            MinimumSize = minNormal;
            StartPosition = FormStartPosition.Manual;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch (ArgumentException) { }
            RestoreWindow();

            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = Color.Black;
            Controls.Add(web);

            BuildTray();
            engineTimer.Tick += (s, e) => PollEngine();
        }

        void BuildTray()
        {
            var menu = new ContextMenuStrip();
            menu.Items.Add("Открыть", null, (s, e) => ShowFromTray());
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Пауза / воспроизведение", null, (s, e) => Post("media", "toggle"));
            menu.Items.Add("Следующий трек", null, (s, e) => Post("media", "next"));
            menu.Items.Add("Предыдущий трек", null, (s, e) => Post("media", "prev"));
            menu.Items.Add("Мини-плеер", null, (s, e) => { ShowFromTray(); SetMini(!mini); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("Выход", null, (s, e) => { exiting = true; Close(); });
            tray = new NotifyIcon { Icon = Icon, Text = "YM Studio", Visible = true, ContextMenuStrip = menu };
            tray.DoubleClick += (s, e) => ShowFromTray();
        }

        void ShowFromTray()
        {
            Show();
            if (WindowState == FormWindowState.Minimized) WindowState = FormWindowState.Normal;
            Activate();
            SetForegroundWindow(Handle);
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            int on = 1;
            DwmSetWindowAttribute(Handle, 20, ref on, 4); // dark title bar
        }

        protected override async void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            try
            {
                var args = "--autoplay-policy=no-user-gesture-required";
                var port = Environment.GetEnvironmentVariable("YMSTUDIO_DEBUG_PORT");
                if (!string.IsNullOrEmpty(port)) args += " --remote-debugging-port=" + port;

                var options = new CoreWebView2EnvironmentOptions(args);
                var env = await CoreWebView2Environment.CreateAsync(null, Path.Combine(dataDir, "WebView2"), options);
                await web.EnsureCoreWebView2Async(env);

                var core = web.CoreWebView2;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDefaultContextMenusEnabled = true;
                core.Settings.IsZoomControlEnabled = true;
                core.WebMessageReceived += OnWebMessage;
                core.NewWindowRequested += OnNewWindow;
                webEnvironment = env;
                core.AddWebResourceRequestedFilter("*/__yms/*", CoreWebView2WebResourceContext.All);
                core.WebResourceRequested += OnLocalFile;

                var modPath = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "mod.js");
                await core.AddScriptToExecuteOnDocumentCreatedAsync(File.ReadAllText(modPath));
                core.Navigate(StartUrl);
            }
            catch (WebView2RuntimeNotFoundException)
            {
                MessageBox.Show(this, "Не найден Microsoft Edge WebView2 Runtime. Установите его с сайта Microsoft и запустите приложение снова.", "YM Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
                exiting = true;
                Close();
            }
            catch (Exception ex)
            {
                MessageBox.Show(this, "Не удалось запустить браузерный движок:\n" + ex.Message, "YM Studio", MessageBoxButtons.OK, MessageBoxIcon.Error);
                exiting = true;
                Close();
            }
        }

        static bool IsMusicHost(string url)
        {
            Uri uri;
            if (!Uri.TryCreate(url, UriKind.Absolute, out uri) || uri.Scheme != "https") return false;
            return uri.Host.StartsWith("music.yandex.", StringComparison.OrdinalIgnoreCase);
        }

        // Yandex sign-in (and social providers it hands off to) needs window.opener, so it stays in a popup.
        static bool IsAuthHost(string host)
        {
            host = host.ToLowerInvariant();
            string[] parts = { "yandex.", "ya.ru", "vk.com", "vk.ru", "mail.ru", "ok.ru", "google.com", "apple.com" };
            foreach (var part in parts) if (host.Contains(part)) return true;
            return false;
        }

        void OnNewWindow(object sender, CoreWebView2NewWindowRequestedEventArgs e)
        {
            Uri uri;
            if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out uri)) { e.Handled = true; return; }
            if (uri.Scheme != "https" && uri.Scheme != "http") { e.Handled = true; return; }
            if (IsAuthHost(uri.Host)) return;
            e.Handled = true;
            try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
            catch (System.ComponentModel.Win32Exception) { }
        }

        // The site's CSP only allows media from its own origin, so wallpaper files are answered on that origin.
        // A range reply may be shorter than asked: the player simply requests the next piece.
        void OnLocalFile(object sender, CoreWebView2WebResourceRequestedEventArgs e)
        {
            if (!IsMusicHost(e.Request.Uri)) return;
            var parts = new Uri(e.Request.Uri).AbsolutePath.Split('/'); // "", "__yms", kind, id
            if (parts.Length != 4 || parts[1] != "__yms") return;
            var file = engine.FileFor(parts[2], parts[3]);
            if (string.IsNullOrEmpty(file) || !File.Exists(file))
            {
                e.Response = webEnvironment.CreateWebResourceResponse(null, 404, "Not Found", "");
                return;
            }
            try
            {
                using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
                {
                    long total = stream.Length, start = 0;
                    bool ranged = e.Request.Headers.Contains("Range");
                    if (ranged)
                    {
                        var value = e.Request.Headers.GetHeader("Range");
                        var dash = value.IndexOf('-');
                        if (!value.StartsWith("bytes=") || dash < 0 || !long.TryParse(value.Substring(6, dash - 6), out start)) start = 0;
                    }
                    if (start >= total && total > 0)
                    {
                        e.Response = webEnvironment.CreateWebResourceResponse(null, 416, "Range Not Satisfiable", "Content-Range: bytes */" + total);
                        return;
                    }
                    long size = ranged ? Math.Min(RangeChunk, total - start) : total;
                    var bytes = new byte[size];
                    stream.Seek(start, SeekOrigin.Begin);
                    int read = 0, n;
                    while (read < size && (n = stream.Read(bytes, read, (int)(size - read))) > 0) read += n;
                    var headers = "Content-Type: " + WallpaperEngine.ContentType(file) + "\nAccept-Ranges: bytes\nContent-Length: " + read;
                    if (ranged) headers += "\nContent-Range: bytes " + start + "-" + (start + read - 1) + "/" + total;
                    e.Response = webEnvironment.CreateWebResourceResponse(new MemoryStream(bytes, 0, read), ranged ? 206 : 200, ranged ? "Partial Content" : "OK", headers);
                }
            }
            catch (IOException) { e.Response = webEnvironment.CreateWebResourceResponse(null, 500, "Read Error", ""); }
            catch (UnauthorizedAccessException) { e.Response = webEnvironment.CreateWebResourceResponse(null, 500, "Read Error", ""); }
        }

        void OnWebMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!IsMusicHost(e.Source)) return;
            Dictionary<string, object> msg;
            try { msg = json.Deserialize<Dictionary<string, object>>(e.WebMessageAsJson); }
            catch (ArgumentException) { return; }
            if (msg == null || !msg.ContainsKey("cmd")) return;

            object value;
            msg.TryGetValue("value", out value);
            bool flag = value is bool && (bool)value;
            switch (msg["cmd"] as string)
            {
                case "ready": PostState(); break;
                case "topmost": pinned = flag; TopMost = pinned || mini; PostState(); break;
                case "mini": SetMini(flag); break;
                case "title":
                    var title = value as string;
                    Text = string.IsNullOrEmpty(title) ? "YM Studio" : title;
                    if (tray != null) tray.Text = Text.Length > 63 ? Text.Substring(0, 63) : Text;
                    break;
                case "caption": SetCaption(value as string); break;
                case "zoom":
                    try { zoom = Math.Max(0.7, Math.Min(1.5, Convert.ToDouble(value, CultureInfo.InvariantCulture))); }
                    catch (FormatException) { break; }
                    catch (InvalidCastException) { break; }
                    if (!mini) web.ZoomFactor = zoom;
                    break;
                case "seethrough": SetSeeThrough(flag); break;
                case "fullscreen": SetFullscreen(flag); break;
                case "tray": closeToTray = flag; break;
                case "toast":
                    var text = value as string;
                    if (!string.IsNullOrEmpty(text) && ActiveForm != this) tray.ShowBalloonTip(3000, "Сейчас играет", text, ToolTipIcon.None);
                    break;
                case "hotkeys": SetHotkeys(value as IEnumerable); break;
                case "we": EngineCommand(value as string); break;
            }
        }

        void Post(string type, object value)
        {
            if (web.CoreWebView2 == null) return;
            web.CoreWebView2.PostWebMessageAsJson(json.Serialize(new Dictionary<string, object> { { "type", type }, { "value", value } }));
        }

        void PostState()
        {
            Post("state", new Dictionary<string, object> { { "topmost", pinned }, { "mini", mini } });
        }

        void SetCaption(string hex)
        {
            if (string.IsNullOrEmpty(hex) || hex.Length != 7 || hex[0] != '#') return;
            int rgb;
            if (!int.TryParse(hex.Substring(1), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out rgb)) return;
            int r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
            int colorref = r | (g << 8) | (b << 16);
            int text = (r * 299 + g * 587 + b * 114) / 1000 > 140 ? 0 : 0xFFFFFF;
            DwmSetWindowAttribute(Handle, 35, ref colorref, 4);
            DwmSetWindowAttribute(Handle, 36, ref text, 4);
        }

        // Pixels the page leaves fully transparent reveal the desktop, with the live wallpaper on it.
        // Blur-behind with an empty region gives per-pixel alpha and no actual blur. Form.TransparencyKey
        // looks the same but makes the window click-through, because the form's own surface is all key colour.
        void SetSeeThrough(bool on)
        {
            if (on == seeThrough) return;
            seeThrough = on;
            var region = on ? CreateRectRgn(0, 0, -1, -1) : IntPtr.Zero;
            var blur = new BlurBehind { Flags = 3, Enable = on, Region = region };
            DwmEnableBlurBehindWindow(Handle, ref blur);
            if (region != IntPtr.Zero) DeleteObject(region);
            web.DefaultBackgroundColor = on ? Color.Transparent : Color.Black;
        }

        void SetFullscreen(bool on)
        {
            if (on == fullscreen || mini) return;
            fullscreen = on;
            if (on)
            {
                fullscreenState = WindowState;
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.None;
                WindowState = FormWindowState.Maximized;
            }
            else
            {
                WindowState = FormWindowState.Normal;
                FormBorderStyle = FormBorderStyle.Sizable;
                WindowState = fullscreenState;
            }
        }

        void SetMini(bool on)
        {
            if (on == mini) { PostState(); return; }
            mini = on;
            web.ZoomFactor = on ? 1 : zoom; // the mini layout is sized for 100%
            if (on)
            {
                savedState = WindowState;
                savedBounds = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
                WindowState = FormWindowState.Normal;
                MinimumSize = Size.Empty;
                float scale = DeviceDpi / 96f;
                ClientSize = new Size((int)(380 * scale), (int)(150 * scale));
                TopMost = true;
            }
            else
            {
                TopMost = pinned;
                MinimumSize = minNormal;
                Bounds = savedBounds;
                WindowState = savedState;
            }
            PostState();
        }

        void SetHotkeys(IEnumerable list)
        {
            foreach (var id in hotkeys.Keys) UnregisterHotKey(Handle, id);
            hotkeys.Clear();
            if (list == null) return;
            var failed = new List<string>();
            int next = FirstHotkeyId;
            foreach (var item in list)
            {
                var map = item as Dictionary<string, object>;
                if (map == null || !map.ContainsKey("action") || !map.ContainsKey("mods") || !map.ContainsKey("vk")) continue;
                var action = map["action"] as string;
                uint mods, vk;
                try { mods = Convert.ToUInt32(map["mods"]); vk = Convert.ToUInt32(map["vk"]); }
                catch (FormatException) { continue; }
                catch (OverflowException) { continue; }
                catch (InvalidCastException) { continue; }
                if (action == null) continue;
                if (RegisterHotKey(Handle, next, mods | MOD_NOREPEAT, vk)) hotkeys[next++] = action;
                else failed.Add(action);
            }
            Post("hotkeys", failed);
        }

        void EngineCommand(string command)
        {
            switch (command)
            {
                case "watch":
                    engineTimer.Start();
                    PostEngine();
                    break;
                case "unwatch": engineTimer.Stop(); break;
                case "videos": Post("wevideos", engine.ListVideos()); break;
            }
        }

        void PostEngine()
        {
            engineStamp = engine.ConfigTime;
            engineRunning = WallpaperEngine.Running;
            Post("we", engine.Describe());
        }

        void PollEngine()
        {
            if (engine.ConfigTime != engineStamp || WallpaperEngine.Running != engineRunning) PostEngine();
        }

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == WM_HOTKEY)
            {
                string action;
                if (hotkeys.TryGetValue(m.WParam.ToInt32(), out action)) Post("media", action);
            }
            else if (m.Msg == (int)Program.ShowMessage) ShowFromTray();
            base.WndProc(ref m);
        }

        void RestoreWindow()
        {
            var area = Screen.PrimaryScreen.WorkingArea;
            var bounds = new Rectangle(area.X + area.Width / 8, area.Y + area.Height / 10, area.Width * 3 / 4, area.Height * 4 / 5);
            bool maximized = false;
            try
            {
                if (File.Exists(windowFile))
                {
                    var p = File.ReadAllText(windowFile).Split(',');
                    var saved = new Rectangle(int.Parse(p[0]), int.Parse(p[1]), int.Parse(p[2]), int.Parse(p[3]));
                    foreach (var screen in Screen.AllScreens)
                    {
                        if (screen.WorkingArea.IntersectsWith(saved)) { bounds = saved; break; }
                    }
                    maximized = p[4] == "1";
                }
            }
            catch (FormatException) { }
            catch (IndexOutOfRangeException) { }
            catch (IOException) { }
            Bounds = bounds;
            if (maximized) WindowState = FormWindowState.Maximized;
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            if (closeToTray && !exiting && e.CloseReason == CloseReason.UserClosing)
            {
                e.Cancel = true;
                Hide();
                return;
            }
            SetFullscreen(false);
            var b = mini ? savedBounds : (WindowState == FormWindowState.Normal ? Bounds : RestoreBounds);
            var state = mini ? savedState : WindowState;
            try
            {
                File.WriteAllText(windowFile, string.Join(",", new[] {
                    b.X.ToString(), b.Y.ToString(), b.Width.ToString(), b.Height.ToString(),
                    state == FormWindowState.Maximized ? "1" : "0" }));
            }
            catch (IOException) { }
            SetHotkeys(null);
            engineTimer.Stop();
            tray.Visible = false;
            tray.Dispose();
            base.OnFormClosing(e);
        }
    }
}
