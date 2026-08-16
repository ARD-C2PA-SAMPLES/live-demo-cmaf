<?xml version="1.0" encoding="utf-8" ?>

<!--
    RTMP statistics UI for the nginx-rtmp ingest container.

    nginx serves /stat as XML and references this stylesheet, so the browser
    renders the dashboard client side. The script at the bottom of the page
    re-fetches /stat every couple of seconds and re-applies this very
    stylesheet, which keeps the markup here the single source of truth for
    how a statistic looks.

    Based on the stat.xsl shipped with nginx-rtmp-module,
    Copyright (C) Roman Arutyunyan.
-->

<xsl:stylesheet version="1.0" xmlns:xsl="http://www.w3.org/1999/XSL/Transform">

<xsl:output method="html" encoding="utf-8" indent="no"/>

<xsl:variable name="streams" select="/rtmp/server/application/live/stream"/>
<xsl:variable name="live" select="$streams[publishing]"/>
<xsl:variable name="transcoders"
              select="$streams/client[not(publishing)][contains(flashver, 'USP-CMAF') or starts-with(address, '127.')]"/>

<xsl:template match="/">
    <html lang="en">
        <head>
            <meta charset="utf-8"/>
            <meta name="viewport" content="width=device-width, initial-scale=1"/>
            <title>RTMP Ingest &#8212; Statistics</title>
            <style><xsl:call-template name="css"/></style>
        </head>
        <body>
            <div id="app"><xsl:call-template name="page"/></div>
            <script><xsl:call-template name="js"/></script>
        </body>
    </html>
</xsl:template>

<!-- ==================================================================== -->
<!-- page                                                                 -->
<!-- ==================================================================== -->

<xsl:template name="page">
    <header class="top">
        <div class="brand">
            <span>
                <xsl:attribute name="class">
                    <xsl:text>dot </xsl:text>
                    <xsl:choose>
                        <xsl:when test="count($live) &gt; 0">dot--live</xsl:when>
                        <xsl:otherwise>dot--idle</xsl:otherwise>
                    </xsl:choose>
                </xsl:attribute>
            </span>
            <div>
                <h1>RTMP Ingest</h1>
                <p class="sub">nginx-rtmp &#8594; FFmpeg &#8594; CMAF &#8594; Unified Origin</p>
            </div>
        </div>
        <div class="meta">
            <span class="pill">nginx&#160;<xsl:value-of select="/rtmp/nginx_version"/></span>
            <span class="pill">rtmp&#160;<xsl:value-of select="/rtmp/nginx_rtmp_version"/></span>
            <span class="pill">pid&#160;<xsl:value-of select="/rtmp/pid"/></span>
            <span class="pill">up&#160;<xsl:call-template name="duration">
                <xsl:with-param name="sec" select="/rtmp/uptime"/>
            </xsl:call-template></span>
            <span class="pill pill--poll" id="poll-state">connecting&#8230;</span>
        </div>
    </header>

    <xsl:call-template name="pipeline"/>

    <section class="tiles">
        <xsl:call-template name="tile">
            <xsl:with-param name="label">Ingest bitrate</xsl:with-param>
            <xsl:with-param name="value">
                <xsl:call-template name="bitrate">
                    <xsl:with-param name="v" select="/rtmp/bw_in"/>
                </xsl:call-template>
            </xsl:with-param>
            <xsl:with-param name="spark" select="'total:in'"/>
            <xsl:with-param name="sparkval" select="/rtmp/bw_in"/>
        </xsl:call-template>

        <xsl:call-template name="tile">
            <xsl:with-param name="label">Egress bitrate</xsl:with-param>
            <xsl:with-param name="value">
                <xsl:call-template name="bitrate">
                    <xsl:with-param name="v" select="/rtmp/bw_out"/>
                </xsl:call-template>
            </xsl:with-param>
            <xsl:with-param name="spark" select="'total:out'"/>
            <xsl:with-param name="sparkval" select="/rtmp/bw_out"/>
        </xsl:call-template>

        <xsl:call-template name="tile">
            <xsl:with-param name="label">Bytes in</xsl:with-param>
            <xsl:with-param name="value">
                <xsl:call-template name="bytes">
                    <xsl:with-param name="v" select="/rtmp/bytes_in"/>
                </xsl:call-template>
            </xsl:with-param>
        </xsl:call-template>

        <xsl:call-template name="tile">
            <xsl:with-param name="label">Bytes out</xsl:with-param>
            <xsl:with-param name="value">
                <xsl:call-template name="bytes">
                    <xsl:with-param name="v" select="/rtmp/bytes_out"/>
                </xsl:call-template>
            </xsl:with-param>
        </xsl:call-template>

        <xsl:call-template name="tile">
            <xsl:with-param name="label">Live streams</xsl:with-param>
            <xsl:with-param name="value" select="count($live)"/>
        </xsl:call-template>

        <xsl:call-template name="tile">
            <xsl:with-param name="label">Connections accepted</xsl:with-param>
            <xsl:with-param name="value" select="/rtmp/naccepted"/>
        </xsl:call-template>
    </section>

    <xsl:choose>
        <xsl:when test="count($streams) &gt; 0">
            <xsl:apply-templates select="/rtmp/server/application"/>
        </xsl:when>
        <xsl:otherwise>
            <xsl:call-template name="empty"/>
        </xsl:otherwise>
    </xsl:choose>

    <footer class="foot">
        <span>
            <a href="https://github.com/arut/nginx-rtmp-module">nginx-rtmp-module</a>
            <xsl:text>&#160;</xsl:text>
            <xsl:value-of select="/rtmp/nginx_rtmp_version"/>
            <xsl:text> on </xsl:text>
            <a href="http://nginx.org">nginx</a>
            <xsl:text>&#160;</xsl:text>
            <xsl:value-of select="/rtmp/nginx_version"/>
        </span>
        <span class="dim">built <xsl:value-of select="/rtmp/built"/></span>
        <span><a href="/stat.xsl">stylesheet</a> &#183; <a id="raw-link" href="/stat">raw XML</a></span>
    </footer>
</xsl:template>

<!-- ==================================================================== -->
<!-- pipeline: encoder -> nginx -> ffmpeg -> origin                       -->
<!-- ==================================================================== -->

<xsl:template name="pipeline">
    <section>
        <xsl:attribute name="class">
            <xsl:text>hero </xsl:text>
            <xsl:choose>
                <xsl:when test="count($live) &gt; 0">hero--live</xsl:when>
                <xsl:otherwise>hero--idle</xsl:otherwise>
            </xsl:choose>
        </xsl:attribute>

        <div class="hero-head">
            <span class="hero-state">
                <xsl:choose>
                    <xsl:when test="count($live) &gt; 0">ON AIR</xsl:when>
                    <xsl:otherwise>WAITING FOR INGEST</xsl:otherwise>
                </xsl:choose>
            </span>
            <span class="hero-note">
                <xsl:choose>
                    <xsl:when test="count($live) &gt; 0">
                        <xsl:value-of select="count($live)"/>
                        <xsl:text> stream(s) publishing, </xsl:text>
                        <xsl:value-of select="count($transcoders)"/>
                        <xsl:text> transcoder(s) attached</xsl:text>
                    </xsl:when>
                    <xsl:otherwise>
                        <xsl:text>Publish to </xsl:text>
                        <code>rtmp://<span class="js-host">localhost</span>:1935/<xsl:value-of
                            select="/rtmp/server/application/name"/>/stream</code>
                    </xsl:otherwise>
                </xsl:choose>
            </span>
        </div>

        <ol class="chain">
            <li>
                <xsl:attribute name="class">
                    <xsl:text>chain-node </xsl:text>
                    <xsl:if test="count($live) &gt; 0">is-on</xsl:if>
                </xsl:attribute>
                <span class="chain-title">Encoder</span>
                <span class="chain-value">
                    <xsl:choose>
                        <xsl:when test="$streams/client[publishing]">
                            <xsl:value-of select="$streams/client[publishing][1]/flashver"/>
                        </xsl:when>
                        <xsl:otherwise>not connected</xsl:otherwise>
                    </xsl:choose>
                </span>
            </li>
            <li>
                <xsl:attribute name="class">
                    <xsl:text>chain-node </xsl:text>
                    <xsl:if test="/rtmp/uptime &gt; 0">is-on</xsl:if>
                </xsl:attribute>
                <span class="chain-title">nginx-rtmp :1935</span>
                <span class="chain-value">
                    <xsl:value-of select="count($streams)"/> stream(s)
                </span>
            </li>
            <li>
                <xsl:attribute name="class">
                    <xsl:text>chain-node </xsl:text>
                    <xsl:if test="count($transcoders) &gt; 0">is-on</xsl:if>
                </xsl:attribute>
                <span class="chain-title">FFmpeg transcoder</span>
                <span class="chain-value">
                    <xsl:choose>
                        <xsl:when test="count($transcoders) &gt; 0">
                            <xsl:value-of select="count($transcoders)"/> running
                        </xsl:when>
                        <xsl:otherwise>stopped</xsl:otherwise>
                    </xsl:choose>
                </span>
            </li>
            <li class="chain-node" id="origin-node">
                <span class="chain-title">Unified Origin</span>
                <span class="chain-value" id="origin-state">&#8230;</span>
                <span class="chain-sub" id="origin-uri"></span>
            </li>
        </ol>
    </section>
</xsl:template>

<!-- ==================================================================== -->
<!-- applications and streams                                             -->
<!-- ==================================================================== -->

<xsl:template match="application">
    <xsl:if test="live/stream">
        <section class="block">
            <h2 class="block-title">
                Application <code><xsl:value-of select="name"/></code>
                <span class="dim">
                    <xsl:value-of select="live/nclients"/> client(s)
                </span>
            </h2>
            <xsl:apply-templates select="live/stream"/>
        </section>
    </xsl:if>
</xsl:template>

<xsl:template match="stream">
    <xsl:variable name="key" select="concat(../../name, '/', name)"/>
    <article>
        <xsl:attribute name="class">
            <xsl:text>card </xsl:text>
            <xsl:choose>
                <xsl:when test="publishing">card--live</xsl:when>
                <xsl:otherwise>card--idle</xsl:otherwise>
            </xsl:choose>
        </xsl:attribute>

        <div class="card-head">
            <h3>
                <xsl:value-of select="../../name"/>
                <xsl:text>/</xsl:text>
                <xsl:choose>
                    <xsl:when test="string-length(name) = 0">[empty]</xsl:when>
                    <xsl:otherwise><xsl:value-of select="name"/></xsl:otherwise>
                </xsl:choose>
            </h3>
            <div class="card-badges">
                <span>
                    <xsl:attribute name="class">
                        <xsl:text>badge </xsl:text>
                        <xsl:choose>
                            <xsl:when test="publishing">badge--live</xsl:when>
                            <xsl:when test="active">badge--warn</xsl:when>
                            <xsl:otherwise>badge--off</xsl:otherwise>
                        </xsl:choose>
                    </xsl:attribute>
                    <xsl:choose>
                        <xsl:when test="publishing">publishing</xsl:when>
                        <xsl:when test="active">active</xsl:when>
                        <xsl:otherwise>idle</xsl:otherwise>
                    </xsl:choose>
                </span>
                <span class="badge badge--plain">
                    <xsl:value-of select="nclients"/> client(s)
                </span>
                <span class="badge badge--plain">
                    up <xsl:call-template name="duration">
                        <xsl:with-param name="sec" select="floor(time div 1000)"/>
                    </xsl:call-template>
                </span>
            </div>
        </div>

        <div class="track-grid">
            <div class="track">
                <div class="track-head">
                    <span class="track-kind">Video</span>
                    <span class="track-rate">
                        <xsl:call-template name="bitrate">
                            <xsl:with-param name="v" select="bw_video"/>
                        </xsl:call-template>
                    </span>
                </div>
                <span class="spark">
                    <xsl:attribute name="data-key"><xsl:value-of select="$key"/>:video</xsl:attribute>
                    <xsl:attribute name="data-value"><xsl:value-of select="bw_video"/></xsl:attribute>
                </span>
                <dl class="kv">
                    <xsl:call-template name="kv">
                        <xsl:with-param name="k">codec</xsl:with-param>
                        <xsl:with-param name="v" select="normalize-space(concat(meta/video/codec, ' ', meta/video/profile, ' ', meta/video/level))"/>
                    </xsl:call-template>
                    <xsl:call-template name="kv">
                        <xsl:with-param name="k">resolution</xsl:with-param>
                        <xsl:with-param name="v" select="concat(meta/video/width, 'x', meta/video/height)"/>
                    </xsl:call-template>
                    <xsl:call-template name="kv">
                        <xsl:with-param name="k">frame rate</xsl:with-param>
                        <xsl:with-param name="v" select="meta/video/frame_rate"/>
                        <xsl:with-param name="unit"> fps</xsl:with-param>
                    </xsl:call-template>
                </dl>
            </div>

            <div class="track">
                <div class="track-head">
                    <span class="track-kind">Audio</span>
                    <span class="track-rate">
                        <xsl:call-template name="bitrate">
                            <xsl:with-param name="v" select="bw_audio"/>
                        </xsl:call-template>
                    </span>
                </div>
                <span class="spark">
                    <xsl:attribute name="data-key"><xsl:value-of select="$key"/>:audio</xsl:attribute>
                    <xsl:attribute name="data-value"><xsl:value-of select="bw_audio"/></xsl:attribute>
                </span>
                <dl class="kv">
                    <xsl:call-template name="kv">
                        <xsl:with-param name="k">codec</xsl:with-param>
                        <xsl:with-param name="v" select="normalize-space(concat(meta/audio/codec, ' ', meta/audio/profile))"/>
                    </xsl:call-template>
                    <xsl:call-template name="kv">
                        <xsl:with-param name="k">sample rate</xsl:with-param>
                        <xsl:with-param name="v" select="meta/audio/sample_rate"/>
                        <xsl:with-param name="unit"> Hz</xsl:with-param>
                    </xsl:call-template>
                    <xsl:call-template name="kv">
                        <xsl:with-param name="k">channels</xsl:with-param>
                        <xsl:with-param name="v" select="meta/audio/channels"/>
                    </xsl:call-template>
                </dl>
            </div>

            <div class="track">
                <div class="track-head">
                    <span class="track-kind">Traffic</span>
                    <span class="track-rate">
                        <xsl:call-template name="bitrate">
                            <xsl:with-param name="v" select="bw_in"/>
                        </xsl:call-template>
                    </span>
                </div>
                <span class="spark">
                    <xsl:attribute name="data-key"><xsl:value-of select="$key"/>:in</xsl:attribute>
                    <xsl:attribute name="data-value"><xsl:value-of select="bw_in"/></xsl:attribute>
                </span>
                <dl class="kv">
                    <xsl:call-template name="kv">
                        <xsl:with-param name="k">bytes in</xsl:with-param>
                        <xsl:with-param name="v">
                            <xsl:call-template name="bytes">
                                <xsl:with-param name="v" select="bytes_in"/>
                            </xsl:call-template>
                        </xsl:with-param>
                    </xsl:call-template>
                    <xsl:call-template name="kv">
                        <xsl:with-param name="k">bytes out</xsl:with-param>
                        <xsl:with-param name="v">
                            <xsl:call-template name="bytes">
                                <xsl:with-param name="v" select="bytes_out"/>
                            </xsl:call-template>
                        </xsl:with-param>
                    </xsl:call-template>
                    <xsl:call-template name="kv">
                        <xsl:with-param name="k">out bitrate</xsl:with-param>
                        <xsl:with-param name="v">
                            <xsl:call-template name="bitrate">
                                <xsl:with-param name="v" select="bw_out"/>
                            </xsl:call-template>
                        </xsl:with-param>
                    </xsl:call-template>
                </dl>
            </div>
        </div>

        <xsl:if test="client">
            <table class="clients">
                <thead>
                    <tr>
                        <th>Role</th>
                        <th>Id</th>
                        <th>Address</th>
                        <th>Client</th>
                        <th class="num">Dropped</th>
                        <th class="num">Timestamp</th>
                        <th class="num">A-V</th>
                        <th class="num">Time</th>
                    </tr>
                </thead>
                <tbody>
                    <xsl:apply-templates select="client"/>
                </tbody>
            </table>
        </xsl:if>
    </article>
</xsl:template>

<xsl:template match="client">
    <tr>
        <td>
            <xsl:choose>
                <xsl:when test="publishing">
                    <span class="badge badge--live">ingest</span>
                </xsl:when>
                <xsl:when test="contains(flashver, 'USP-CMAF') or starts-with(address, '127.')">
                    <span class="badge badge--accent">transcoder</span>
                </xsl:when>
                <xsl:otherwise>
                    <span class="badge badge--plain">player</span>
                </xsl:otherwise>
            </xsl:choose>
        </td>
        <td class="mono"><xsl:value-of select="id"/></td>
        <td class="mono"><xsl:value-of select="address"/></td>
        <td class="mono dim"><xsl:value-of select="flashver"/></td>
        <td class="num">
            <xsl:choose>
                <xsl:when test="dropped &gt; 0"><span class="warn"><xsl:value-of select="dropped"/></span></xsl:when>
                <xsl:otherwise><xsl:value-of select="dropped"/></xsl:otherwise>
            </xsl:choose>
        </td>
        <td class="num"><xsl:value-of select="timestamp"/></td>
        <td class="num"><xsl:value-of select="avsync"/></td>
        <td class="num">
            <xsl:call-template name="duration">
                <xsl:with-param name="sec" select="floor(time div 1000)"/>
            </xsl:call-template>
        </td>
    </tr>
</xsl:template>

<!-- ==================================================================== -->
<!-- empty state                                                          -->
<!-- ==================================================================== -->

<xsl:template name="empty">
    <section class="block empty">
        <h2>No stream is being published</h2>
        <p>
            nginx keeps listening; the FFmpeg transcoder is started
            automatically as soon as an encoder connects and is stopped
            again when it disconnects.
        </p>
        <p class="dim">Point your encoder at:</p>
        <pre>rtmp://<span class="js-host">localhost</span>:1935/<xsl:value-of
            select="/rtmp/server/application/name"/>/stream</pre>
        <p class="dim">For example with FFmpeg:</p>
        <pre>ffmpeg -re -f lavfi -i testsrc2=size=1280x720:rate=25 \
       -f lavfi -i sine=frequency=440:sample_rate=48000 \
       -c:v libx264 -preset veryfast -tune zerolatency -g 50 -b:v 2500k \
       -c:a aac -b:a 128k -f flv \
       rtmp://<span class="js-host">localhost</span>:1935/<xsl:value-of
            select="/rtmp/server/application/name"/>/stream</pre>
    </section>
</xsl:template>

<!-- ==================================================================== -->
<!-- small helpers                                                        -->
<!-- ==================================================================== -->

<xsl:template name="tile">
    <xsl:param name="label"/>
    <xsl:param name="value"/>
    <xsl:param name="spark"/>
    <xsl:param name="sparkval"/>
    <div class="tile">
        <span class="tile-label"><xsl:value-of select="$label"/></span>
        <span class="tile-value"><xsl:copy-of select="$value"/></span>
        <xsl:if test="$spark">
            <span class="spark spark--wide">
                <xsl:attribute name="data-key"><xsl:value-of select="$spark"/></xsl:attribute>
                <xsl:attribute name="data-value"><xsl:value-of select="$sparkval"/></xsl:attribute>
            </span>
        </xsl:if>
    </div>
</xsl:template>

<xsl:template name="kv">
    <xsl:param name="k"/>
    <xsl:param name="v"/>
    <xsl:param name="unit"/>
    <div class="kv-row">
        <dt><xsl:value-of select="$k"/></dt>
        <dd>
            <xsl:choose>
                <xsl:when test="string-length(normalize-space($v)) = 0 or normalize-space($v) = 'x'">
                    <span class="dim">&#8212;</span>
                </xsl:when>
                <xsl:otherwise>
                    <xsl:copy-of select="$v"/>
                    <xsl:value-of select="$unit"/>
                </xsl:otherwise>
            </xsl:choose>
        </dd>
    </div>
</xsl:template>

<!-- seconds -> "3d 4h", "4h 07m", "7m 12s", "12s" -->
<xsl:template name="duration">
    <xsl:param name="sec"/>
    <xsl:choose>
        <xsl:when test="not($sec &gt;= 0)">&#8212;</xsl:when>
        <xsl:when test="$sec &gt;= 86400">
            <xsl:value-of select="floor($sec div 86400)"/>d&#160;<xsl:value-of
                select="format-number(floor($sec div 3600) mod 24, '00')"/>h</xsl:when>
        <xsl:when test="$sec &gt;= 3600">
            <xsl:value-of select="floor($sec div 3600)"/>h&#160;<xsl:value-of
                select="format-number(floor($sec div 60) mod 60, '00')"/>m</xsl:when>
        <xsl:when test="$sec &gt;= 60">
            <xsl:value-of select="floor($sec div 60)"/>m&#160;<xsl:value-of
                select="format-number($sec mod 60, '00')"/>s</xsl:when>
        <xsl:otherwise><xsl:value-of select="$sec"/>s</xsl:otherwise>
    </xsl:choose>
</xsl:template>

<!-- bits per second, decimal units as usual for bitrates -->
<xsl:template name="bitrate">
    <xsl:param name="v"/>
    <xsl:choose>
        <xsl:when test="string-length($v) = 0">&#8212;</xsl:when>
        <xsl:when test="$v &gt;= 1000000">
            <xsl:value-of select="format-number($v div 1000000, '0.00')"/>&#160;Mb/s</xsl:when>
        <xsl:when test="$v &gt;= 1000">
            <xsl:value-of select="format-number($v div 1000, '0')"/>&#160;kb/s</xsl:when>
        <xsl:otherwise><xsl:value-of select="$v"/>&#160;b/s</xsl:otherwise>
    </xsl:choose>
</xsl:template>

<!-- bytes, binary units -->
<xsl:template name="bytes">
    <xsl:param name="v"/>
    <xsl:choose>
        <xsl:when test="string-length($v) = 0">&#8212;</xsl:when>
        <xsl:when test="$v &gt;= 1099511627776">
            <xsl:value-of select="format-number($v div 1099511627776, '0.00')"/>&#160;TiB</xsl:when>
        <xsl:when test="$v &gt;= 1073741824">
            <xsl:value-of select="format-number($v div 1073741824, '0.00')"/>&#160;GiB</xsl:when>
        <xsl:when test="$v &gt;= 1048576">
            <xsl:value-of select="format-number($v div 1048576, '0.0')"/>&#160;MiB</xsl:when>
        <xsl:when test="$v &gt;= 1024">
            <xsl:value-of select="format-number($v div 1024, '0')"/>&#160;KiB</xsl:when>
        <xsl:otherwise><xsl:value-of select="$v"/>&#160;B</xsl:otherwise>
    </xsl:choose>
</xsl:template>

<!-- ==================================================================== -->
<!-- assets                                                               -->
<!-- ==================================================================== -->

<xsl:template name="css">
<![CDATA[
/* Dark monitoring theme, same palette and typography as the C2PA player
   in c2pa-live-dashjs/styles.css so both pages read as one product. */
:root {
  color-scheme: dark;
  --bg: #0d1117;
  --panel: #161b22;
  --panel-2: #1c2129;
  --line: #30363d;
  --text: #e6edf3;
  --muted: #8b949e;
  --accent: #58a6ff;
  --live: #3fb950;
  --warn: #d29922;
  --off: #6e7681;
  --mono: ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
  --radius: 12px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 22px clamp(16px, 4vw, 48px) 48px;
  background: var(--bg);
  color: var(--text);
  font: 14px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-variant-numeric: tabular-nums;
}
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
code, pre, .mono { font-family: var(--mono); font-size: 0.92em; }
.dim { color: var(--muted); }
.warn { color: var(--warn); }

/* header */
.top {
  display: flex; flex-wrap: wrap; gap: 16px;
  align-items: center; justify-content: space-between;
  padding-bottom: 18px; margin-bottom: 20px;
  border-bottom: 1px solid var(--line);
}
.brand { display: flex; align-items: center; gap: 14px; }
.brand h1 { margin: 0; font-size: 20px; letter-spacing: -0.01em; }
.sub { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
.dot { width: 12px; height: 12px; border-radius: 50%; background: var(--off); flex: none; }
.dot--live { background: var(--live); box-shadow: 0 0 0 0 rgba(46,226,122,.6); animation: pulse 2s infinite; }
.dot--idle { background: var(--off); }
@keyframes pulse {
  70% { box-shadow: 0 0 0 10px rgba(46,226,122,0); }
  100% { box-shadow: 0 0 0 0 rgba(46,226,122,0); }
}
.meta { display: flex; flex-wrap: wrap; gap: 8px; }
.pill {
  padding: 4px 10px; border: 1px solid var(--line); border-radius: 999px;
  background: var(--panel); color: var(--muted); font-size: 12px;
}
.pill--poll { border-color: transparent; background: color-mix(in srgb, var(--accent) 16%, transparent); color: var(--accent); }
.pill--poll.is-stale { background: color-mix(in srgb, var(--warn) 20%, transparent); color: var(--warn); }

/* hero + pipeline */
.hero {
  border: 1px solid var(--line); border-radius: var(--radius);
  background: linear-gradient(180deg, #131922, var(--panel));
  padding: 18px 20px; margin-bottom: 18px;
}
.hero--live { border-color: color-mix(in srgb, var(--live) 45%, var(--line)); }
.hero-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 14px; }
.hero-state { font-size: 22px; font-weight: 700; letter-spacing: .06em; }
.hero--live .hero-state { color: var(--live); }
.hero--idle .hero-state { color: var(--muted); }
.hero-note { color: var(--muted); }
.hero-note code { color: var(--text); background: var(--bg); padding: 2px 6px; border-radius: 6px; border: 1px solid var(--line); }

.chain { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; list-style: none; margin: 16px 0 0; padding: 0; }
.chain-node {
  position: relative; padding: 12px 14px; border-radius: 10px;
  border: 1px dashed var(--line); background: var(--bg);
  display: flex; flex-direction: column; gap: 2px;
}
.chain-node.is-on { border-style: solid; border-color: color-mix(in srgb, var(--live) 50%, var(--line)); }
.chain-title { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.chain-value { font-weight: 600; overflow-wrap: anywhere; }
.chain-node.is-on .chain-value { color: var(--live); }
.chain-sub { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.chain-node + .chain-node::before {
  content: "\203A"; position: absolute; left: -11px; top: 50%; transform: translateY(-50%);
  color: var(--muted); font-size: 18px;
}
@media (max-width: 760px) { .chain-node + .chain-node::before { content: none; } }

/* tiles */
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(170px, 1fr)); gap: 12px; margin-bottom: 22px; }
.tile { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 14px 16px; }
.tile-label { display: block; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.tile-value { display: block; margin-top: 6px; font-size: 22px; font-weight: 650; }

/* sparkline */
.spark { display: block; height: 26px; margin-top: 8px; color: var(--accent); }
.spark svg { display: block; width: 100%; height: 100%; overflow: visible; }
.spark--wide { height: 30px; }
.card--live .spark, .hero--live .spark { color: var(--live); }

/* stream cards */
.block { margin-bottom: 24px; }
.block-title { display: flex; align-items: baseline; gap: 10px; font-size: 13px; font-weight: 600;
  text-transform: uppercase; letter-spacing: .08em; color: var(--muted); margin: 0 0 10px; }
.block-title code { text-transform: none; letter-spacing: 0; color: var(--text); }
.card { border: 1px solid var(--line); border-radius: var(--radius); background: var(--panel); padding: 16px 18px; margin-bottom: 14px; }
.card--live { border-color: color-mix(in srgb, var(--live) 35%, var(--line)); }
.card-head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
.card-head h3 { margin: 0; font-size: 17px; }
.card-badges { display: flex; flex-wrap: wrap; gap: 6px; }
.badge { padding: 3px 9px; border-radius: 999px; font-size: 11px; font-weight: 600; letter-spacing: .04em;
  text-transform: uppercase; border: 1px solid var(--line); color: var(--muted); background: var(--bg); }
.badge--live { color: var(--live); border-color: color-mix(in srgb, var(--live) 45%, transparent); background: color-mix(in srgb, var(--live) 14%, transparent); }
.badge--accent { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); background: color-mix(in srgb, var(--accent) 14%, transparent); }
.badge--warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 14%, transparent); }
.badge--off, .badge--plain { color: var(--muted); }

.track-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; margin-top: 14px; }
.track { border: 1px solid var(--line); border-radius: 10px; background: var(--panel-2); padding: 12px 14px; }
.track-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
.track-kind { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
.track-rate { font-size: 17px; font-weight: 650; }
.kv { margin: 6px 0 0; }
.kv-row { display: flex; justify-content: space-between; gap: 10px; padding: 3px 0; border-top: 1px solid var(--line); }
.kv-row:first-child { border-top: 0; }
.kv dt { color: var(--muted); font-size: 12px; margin: 0; }
.kv dd { margin: 0; font-size: 12px; }

/* clients */
.clients { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 12px; }
.clients th { text-align: left; font-weight: 600; color: var(--muted); text-transform: uppercase;
  letter-spacing: .06em; font-size: 11px; padding: 6px 8px; border-bottom: 1px solid var(--line); }
.clients td { padding: 6px 8px; border-bottom: 1px solid var(--line); }
.clients tr:last-child td { border-bottom: 0; }
.clients .num { text-align: right; }

/* empty state */
.empty { border: 1px dashed var(--line); border-radius: var(--radius); padding: 22px; background: var(--panel); }
.empty h2 { margin: 0 0 8px; font-size: 17px; }
.empty p { margin: 0 0 10px; max-width: 70ch; color: var(--muted); }
.empty pre { margin: 0 0 14px; padding: 12px 14px; border-radius: 10px; background: var(--bg);
  border: 1px solid var(--line); overflow-x: auto; font-size: 12px; color: var(--text); }

/* footer */
.foot { display: flex; flex-wrap: wrap; gap: 8px 20px; justify-content: space-between;
  margin-top: 28px; padding-top: 14px; border-top: 1px solid var(--line);
  color: var(--muted); font-size: 12px; }
]]>
</xsl:template>

<xsl:template name="js">
<![CDATA[
(function () {
  "use strict";

  var REFRESH_MS = 2000;
  var HISTORY = 60;

  var app = document.getElementById("app");
  var processor = null;
  var history = {};
  var failures = 0;

  function setPollState(text, stale) {
    var el = document.getElementById("poll-state");
    if (!el) return;
    el.textContent = text;
    el.className = "pill pill--poll" + (stale ? " is-stale" : "");
  }

  function fillHost() {
    var host = location.hostname || "localhost";
    var nodes = document.querySelectorAll(".js-host");
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = host;
  }

  // Sparklines are drawn from values collected across polls: the stylesheet
  // only emits the current sample as a data attribute.
  function drawSparklines() {
    var nodes = document.querySelectorAll(".spark");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var key = node.getAttribute("data-key");
      var value = parseFloat(node.getAttribute("data-value"));
      if (!key || isNaN(value)) continue;

      var series = history[key] || (history[key] = []);
      series.push(value);
      if (series.length > HISTORY) series.shift();

      node.innerHTML = sparkline(series);
    }
  }

  function sparkline(series) {
    var w = 100, h = 26, max = 1;
    for (var i = 0; i < series.length; i++) if (series[i] > max) max = series[i];
    max = max * 1.15;

    // a single sample is a dot, not a line - wait for the next poll
    if (series.length < 2) {
      return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
        '<line x1="0" y1="' + (h - 1) + '" x2="' + w + '" y2="' + (h - 1) + '" ' +
        'stroke="currentColor" stroke-width="1" opacity=".25" vector-effect="non-scaling-stroke"/></svg>';
    }

    var step = w / (series.length - 1);
    var line = [], area = ["0," + h];
    for (var j = 0; j < series.length; j++) {
      var x = (j * step).toFixed(2);
      var y = (h - (series[j] / max) * (h - 2) - 1).toFixed(2);
      line.push(x + "," + y);
      area.push(x + "," + y);
    }
    area.push(w + "," + h);

    return '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polygon points="' + area.join(" ") + '" fill="currentColor" opacity=".10"/>' +
      '<polyline points="' + line.join(" ") + '" fill="none" stroke="currentColor" ' +
      'stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>' +
      '</svg>';
  }

  // The publishing point the transcoder ingests into is not part of the RTMP
  // statistics, it is written next to this stylesheet by the container.
  function loadOrigin() {
    fetch("ingest.json", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (info) {
        if (!info) return;
        var uri = document.getElementById("origin-uri");
        if (uri) uri.textContent = info.pub_point_uri || "";
      })
      .catch(function () {});

    fetch("origin/state", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.text() : null; })
      .then(function (text) {
        var node = document.getElementById("origin-node");
        var state = document.getElementById("origin-state");
        if (!state) return;
        if (!text) { state.textContent = "unreachable"; return; }
        var doc = new DOMParser().parseFromString(text, "application/xml");
        var metas = doc.getElementsByTagName("meta");
        var value = "unknown";
        for (var i = 0; i < metas.length; i++) {
          if (metas[i].getAttribute("name") === "state") value = metas[i].getAttribute("content");
        }
        state.textContent = value;
        if (node && value === "started") node.className = "chain-node is-on";
      })
      .catch(function () {
        var state = document.getElementById("origin-state");
        if (state) state.textContent = "unreachable";
      });
  }

  function render() {
    fillHost();
    drawSparklines();
    loadOrigin();
  }

  function tick() {
    fetch("stat", { cache: "no-store" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text();
      })
      .then(function (text) {
        var xml = new DOMParser().parseFromString(text, "application/xml");
        if (xml.getElementsByTagName("parsererror").length) throw new Error("bad XML");

        var fragment = processor.transformToFragment(xml, document);
        var next = fragment && fragment.querySelector("#app");
        if (!next) throw new Error("transform failed");

        app.innerHTML = next.innerHTML;
        failures = 0;
        setPollState("live · " + new Date().toLocaleTimeString(), false);
        render();
      })
      .catch(function (err) {
        failures++;
        setPollState("no data (" + failures + ") · " + err.message, true);
      });
  }

  function start() {
    fetch("stat.xsl", { cache: "no-store" })
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var xsl = new DOMParser().parseFromString(text, "application/xml");
        processor = new XSLTProcessor();
        processor.importStylesheet(xsl);
        setInterval(function () {
          if (!document.hidden) tick();
        }, REFRESH_MS);
        tick();
      })
      .catch(function () {
        // No live updates available, fall back to plain reloads.
        setPollState("auto reload", true);
        setInterval(function () { location.reload(); }, 5000);
      });
  }

  render();
  if (window.XSLTProcessor && window.fetch) {
    start();
  } else {
    setPollState("auto reload", true);
    setInterval(function () { location.reload(); }, 5000);
  }
})();
]]>
</xsl:template>

</xsl:stylesheet>
