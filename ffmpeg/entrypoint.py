#!/usr/bin/python3
"""
Entrypoint to run ffmpeg
"""
import json
import logging
import os
import signal
import subprocess
from collections.abc import Iterable
from datetime import datetime, timezone
from fractions import Fraction


logger = logging.getLogger(__name__)
handler = logging.StreamHandler()
formatter = logging.Formatter(
    "%(asctime)s - %(name)s - %(levelname)s - %(message)s")
handler.setFormatter(formatter)
logger.addHandler(handler)
logger.setLevel(logging.DEBUG)


def flatten(items):
    """Yield items from any nested iterable, use to flatten command"""
    for x in items:
        if isinstance(x, Iterable) and not isinstance(x, (str, bytes)):
            yield from flatten(x)
        else:
            yield x


def run(command, grace_seconds=5):
    """Run ffmpeg and pass termination signals on to it.

    ffmpeg starts its shutdown on the first SIGTERM but 6.x can get stuck in
    there and only hard exits after a handful of signals. Whoever stops us
    (docker, or nginx-rtmp when the publisher disconnects) does not follow up
    with a SIGKILL of its own, so an ffmpeg left behind would keep ingesting
    into the origin. Give it grace_seconds to close its CMAF uploads, then
    kill it.
    """
    proc = subprocess.Popen(command)

    def terminate(signum, _frame):
        logger.info("signal %s, stopping ffmpeg", signum)
        try:
            proc.terminate()
        except OSError:
            pass
        signal.alarm(grace_seconds)

    def force_kill(_signum, _frame):
        logger.warning("ffmpeg did not stop within %ss, killing it",
                       grace_seconds)
        try:
            proc.kill()
        except OSError:
            pass

    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    signal.signal(signal.SIGALRM, force_kill)

    returncode = proc.wait()
    signal.alarm(0)
    return returncode


def muxer_has_option(option):
    """Is option supported by this build's mp4 muxer?

    -audio_track_timescale comes from an out of tree patch (see
    0002-add-audio_track_timescale-option.patch), a distribution FFmpeg does
    not have it.
    """
    try:
        muxer_help = subprocess.run(
            FFMPEG + ["-hide_banner", "-h", "muxer=mp4"],
            capture_output=True, text=True, check=False).stdout
    except OSError:
        return False
    return f"-{option} " in muxer_help


# fixed options
FFMPEG = ["ffmpeg"]
MOVFLAGS = "empty_moov+separate_moof+default_base_moof+frag_discont+cmaf"
ALL_TRACK_OPTS = [
    "-fflags", "genpts",
    "-write_prft", "pts",
    "-movflags", MOVFLAGS,
    "-f", "mp4",
    ]

# env options
if "PUB_POINT_URI" in os.environ:
    pub_point_uri = os.environ["PUB_POINT_URI"]
else:
    logger.critical("must set PUB_POINT_URI")
    exit(1)

hostname = os.environ["HOSTNAME"] if "HOSTNAME" in os.environ else "ffmpeg"
frame_rate = os.environ["FRAME_RATE"] if "FRAME_RATE" in os.environ else "25"
gop_length = os.environ["GOP_LENGTH"] if "GOP_LENGTH" in os.environ else "24"
rtmp_url = os.environ["RTMP_URL"] if "RTMP_URL" in os.environ else "rtmp://0.0.0.0:1935/live/stream"

# Listen for an encoder ourselves (the default), or read an already published
# stream from an RTMP server. The latter is what the nginx-rtmp container in
# upd/ does: nginx terminates the encoder session and starts us per stream.
rtmp_listen = os.environ.get("RTMP_LISTEN", "1").lower() not in ("0", "false", "no", "")
rtmp_flashver = os.environ.get("RTMP_FLASHVER", "")

# logo overlay is off by default, set LOGO_OVERLAY to a file/URL to enable it
logo_overlay = os.environ["LOGO_OVERLAY"] if "LOGO_OVERLAY" in os.environ else ""
logo_filter = ""
if logo_overlay:
    logo_overlay = ["-i", logo_overlay]
    logo_filter = ";[v][1]overlay=eval=init:x=15:y=15[v]"
else:
    logo_overlay = []

# defaults
DEFAULT_TRACKS = {
    "video": [
        {
            "width": 1280,
            "height": 720,
            "bitrate": "700k",
            "codec": "libx264",
            "framerate": frame_rate,
            "gop": gop_length,
            "timescale": 10000000
        }
    ],
    "audio": [
        {
            "samplerate": 48000,
            "bitrate": "64k",
            "codec": "aac",
            "language": "eng",
            "timescale": 48000,
            "frag_duration_micros": 1920000
        }
    ]
}

# handle tracks
tracks = json.loads(os.environ["TRACKS"]) if "TRACKS" in os.environ else DEFAULT_TRACKS

# verify tracks make sense
# if multiple videos, do their frame rates & gops line up
if len(tracks["video"]) > 1:
    if len(set([Fraction(x["framerate"])/Fraction(x["gop"]) for x in tracks["video"]])) != 1:
        logger.critical("mismatched framerates/gop lengths")
        exit(1)
    if len(set([x["timescale"] for x in tracks["video"]])) != 1:
        logger.critical("mismatched video timescales not supported")
        exit(1)

# audio check sample rate and timescales
if len(tracks["audio"]) > 1:
    if len(set([x["samplerate"] for x in tracks["audio"]])) != 1:
        logger.critical("mismatched audio sample rates not supported")
        exit(1)
    if len(set([x["timescale"] for x in tracks["audio"]])) != 1:
        logger.critical("mismatched audio timescales not supported")
        exit(1)

# use highest framerate, resolution, etc for source and filters
max_framerate = max([Fraction(x["framerate"]) for x in tracks["video"]])
max_width = max([x["width"] for x in tracks["video"]])
max_height = max([x["height"] for x in tracks["video"]])

# Timing stuff
# floor to gop length based offset from epoch
gop = Fraction(Fraction(tracks["video"][0]["gop"]), Fraction(tracks["video"][0]["framerate"]))
now = Fraction(
        int(Fraction(Fraction(datetime.now().timestamp()), gop)),
        1/gop)

now_seconds = int(now)
now_micro = int(now % 1 * 1000000)

video_offset = int(tracks["video"][0]["timescale"] * now)
audio_offset = int(tracks["audio"][0]["timescale"] * now)

now_mod_days = Fraction(int(now * 1000000) % 86400000000, 1000000)

max_framerate_int = int(max_framerate)
now_utc = datetime.fromtimestamp(float(now), timezone.utc)
now_timecode = (now_utc.strftime("%H\\:%M\\:%S"))
now_milliseconds = int((now_utc.strftime("%f"))[:-3])
now_frames = int(now_milliseconds / (1000 / max_framerate_int))

logger.debug(f"max_framerate_int {max_framerate_int}")
logger.debug(f"now_timecode {now_timecode}")
logger.debug(f"now_milliseconds {now_milliseconds}")
logger.debug(f"now_frames {now_frames}")
logger.debug(f"now {now}")
logger.debug(f"float(now) {float(now)}")
logger.debug(f"now_seconds {now_seconds}")
logger.debug(f"now_micro {now_micro:06d}")
logger.debug(f"video_offset {video_offset}")
logger.debug(f"audio_offset {audio_offset}")
logger.debug(f"now_mod_days {now_mod_days}")
logger.debug(f"float(now_mod_days) {float(now_mod_days)}")

# build the stupid command

# input rtmp stream, listen for an incoming encoder connection unless we are
# reading the stream from an RTMP server
rtmp_input = []
if rtmp_listen:
    rtmp_input.extend(["-listen", "1"])
if rtmp_flashver:
    rtmp_input.extend(["-rtmp_flashver", rtmp_flashver])
rtmp_input.extend([
    "-fflags", "+genpts",
    "-i", rtmp_url,
])

# build the filter
filter_complex = f"""
[0:v]fps={max_framerate},
scale={max_width}:{max_height}:force_original_aspect_ratio=decrease,
pad={max_width}:{max_height}:(ow-iw)/2:(oh-ih)/2,
setsar=1,
drawtext=box=1:boxcolor=black:boxborderw=1:timecode_rate={max_framerate_int}: timecode='{now_timecode}\\:{now_frames}'" : tc24hmax=1: fontsize=h/25: x=(w-tw)/2+tw/2: y=h/25: fontcolor=white,
drawtext=box=1:boxcolor=black:boxborderw=1:text='%{{pts\\:gmtime\\:{now_seconds}\\:%Y-%m-%d}}\\ ': fontsize=h/25: x=(w-tw)/2-tw/2: y=h/25: fontcolor=white,
drawtext=
    text='C2PA-signed DASH-Livestream':
    fontsize=h/25:
    x=(w-text_w)/2:
    y=h/25*2.5:
    fontcolor=white,
drawtext=
    fontcolor=white:
    fontsize=h/40:
    text='Active ContainerID {hostname}':
    x=(w-text_w)/2:
    y=h/25*4
    [v];
[0:a]aresample={tracks["audio"][0]["samplerate"]}:async=1[a]
{logo_filter}
;[v]setpts=N+{now_seconds}.{now_micro:06d}/TB,split={len(tracks["video"])}{"".join(["[v"+str(x)+"]" for x in range(1, len(tracks["video"])+1)])};
[a]asetpts=N+1024+{now_seconds}.{now_micro:06d}/TB,asplit={len(tracks["audio"])}{"".join(["[a"+str(x)+"]" for x in range(1, len(tracks["audio"])+1)])}
"""

command = [
    FFMPEG,
    "-nostats",
    rtmp_input,
    logo_overlay,
    "-filter_complex", filter_complex,
]

# all the various outputs
count = 0
for video in tracks["video"]:
    count += 1
    command.extend([
        "-map", f"[v{count}]",
        "-fps_mode", "passthrough",
        "-s", f"{video['width']}x{video['height']}",
        "-c:v", "libx264",
        "-b:v", video["bitrate"],
    ])
    # insert optional options
    if "preset" in video:
        command.extend(["-preset", f"{video['preset']}"])
    else:
        command.extend(["-preset", "superfast"])
    if "profile" in video:
        command.extend(["-profile:v", f"{video['profile']}"])
    if "level" in video:
        command.extend(["-level", f"{video['level']}"])
    if "x264-params" in video:
        command.extend(["-x264-params", f"{video['x264-params']}"])
    command.extend([
        "-tune", "zerolatency",
        "-g", str(video["gop"]),
        # "-r", str(video["framerate"]),
        "-video_track_timescale", str(video["timescale"]),
        ALL_TRACK_OPTS,
    ])
    if "name" in video:
        command.extend([f"{pub_point_uri}/Streams({video['name']})"])
    else:
        command.extend([f"{pub_point_uri}/Streams(video_{video['width']}x{video['height']}_{video['bitrate']}.cmfv)"])

audio_track_timescale = muxer_has_option("audio_track_timescale")

count = 0
for audio in tracks["audio"]:
    if "channels" in audio:
        channels = str(audio["channels"])
    else:
        channels = "1"
    count += 1
    command.extend([
        "-map", f"[a{count}]",
        "-c:a", "aac",
        "-b:a", str(audio["bitrate"]),
        "-ar", str(audio["samplerate"]),
        "-ac", channels,
        "-metadata:s:a:0", f"language={audio['language']}",
    ])
    if audio_track_timescale:
        command.extend(["-audio_track_timescale", str(audio["timescale"])])
    elif int(audio["timescale"]) != int(audio["samplerate"]):
        # without the option the muxer uses the sample rate as timescale
        logger.warning(
            "this ffmpeg build has no -audio_track_timescale, using %s "
            "instead of the requested %s",
            audio["samplerate"], audio["timescale"])
    if "frag_duration_micros" in audio:
        command.extend(["-frag_duration", str(audio["frag_duration_micros"])])
    command.extend([
        ALL_TRACK_OPTS,
    ])
    if "name" in audio:
        command.extend([f"{pub_point_uri}/Streams({audio['name']})"])
    else:
        command.extend([f"{pub_point_uri}/Streams(audio_{audio['language']}_{audio['bitrate']}.cmfa)"])

command = list(flatten(command))
logger.debug(f"ffmpeg command: {command}")

exit(run(command, grace_seconds=int(os.environ.get("STOP_GRACE_SECONDS", "5"))))
