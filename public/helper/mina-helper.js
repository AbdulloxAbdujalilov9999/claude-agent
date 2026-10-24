// Mina Helper: runs one allowed action on this Mac. Called by mina-helper.sh with the job JSON.
// Only these actions exist: open_app, open_url, media, volume, notify. Nothing from the job
// is ever run as a command or script.
ObjC.import("Foundation");

function run(argv) {
  var job;
  try {
    job = JSON.parse(argv[0]);
  } catch (e) {
    return JSON.stringify({ id: null, ok: false, output: "Bad job" });
  }
  var app = Application.currentApplication();
  app.includeStandardAdditions = true;
  try {
    return JSON.stringify({ id: job.id, ok: true, output: perform(app, job) });
  } catch (e) {
    return JSON.stringify({ id: job.id, ok: false, output: String(e).slice(0, 500) });
  }
}

function perform(app, job) {
  switch (job.action) {
    case "open_app": {
      var name = String(job.name || "");
      if (!/^[\p{L}\p{N} .&'+()-]{1,60}$/u.test(name)) throw new Error("App name looks invalid");
      // NSWorkspace launches by name without going through a shell.
      var ws = $.NSWorkspace.sharedWorkspace;
      var path = ObjC.unwrap(ws.fullPathForApplication(name));
      if (!path) throw new Error("No app called " + name + " is installed");
      ws.openURL($.NSURL.fileURLWithPath(path));
      return "Opened " + name;
    }
    case "open_url": {
      var url = String(job.url || "");
      if (!/^https?:\/\//i.test(url)) throw new Error("Only web links can be opened");
      $.NSWorkspace.sharedWorkspace.openURL($.NSURL.URLWithString(url));
      return "Opened " + url;
    }
    case "media": {
      var cmd = String(job.command || "");
      if (["playpause", "play", "pause", "next", "previous"].indexOf(cmd) < 0) throw new Error("Unknown media command");
      var player = running("Spotify") ? Application("Spotify") : running("Music") ? Application("Music") : null;
      if (!player) throw new Error("Neither Spotify nor Apple Music is open");
      if (cmd === "next") player.nextTrack();
      else if (cmd === "previous") player.previousTrack();
      else if (cmd === "play") player.play();
      else if (cmd === "pause") player.pause();
      else player.playpause();
      return cmd + " in " + player.name();
    }
    case "volume": {
      var level = Math.max(0, Math.min(100, Math.round(Number(job.level))));
      if (!isFinite(level)) throw new Error("Volume must be 0-100");
      app.setVolume(null, { outputVolume: level });
      return "Volume set to " + level;
    }
    case "notify": {
      app.displayNotification(String(job.text || "").slice(0, 200), { withTitle: "Mina" });
      return "Shown";
    }
    default:
      throw new Error("Unknown action");
  }
}

function running(name) {
  return Application("System Events").processes.whose({ name: name }).length > 0;
}
