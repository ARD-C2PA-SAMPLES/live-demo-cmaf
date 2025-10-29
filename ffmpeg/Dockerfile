# ffmpeg - http://ffmpeg.org/download.html
# based on image from
# https://hub.docker.com/r/jrottenberg/ffmpeg/
#
#
ARG ALPINEVERSION=3.22

FROM alpine:$ALPINEVERSION

ENV     PKG_CONFIG_PATH=/usr/local/lib/pkgconfig \
        SRC=/usr/local

RUN     buildDeps="autoconf \
        automake \
        bash \
        binutils \
        bzip2 \
        cmake \
        curl \
        coreutils \
        g++ \
        gcc \
        git \
        libtool \
        make \
        nasm \
        numactl-dev \
        openssl-dev \
        tar \
        python3 \
        pkgconfig \
        zlib-dev" && \
        export MAKEFLAGS="-j$(($(grep -c ^processor /proc/cpuinfo) + 1))" && \
        apk add --update ${buildDeps} freetype-dev fontconfig-dev ttf-droid libgcc libstdc++ ca-certificates harfbuzz-dev && \
        DIR=$(mktemp -d) && cd ${DIR} && \
        echo "**** COMPILING x264 ****" && \
        git clone --depth 1 https://code.videolan.org/videolan/x264.git . && \
        ./configure --prefix="${SRC}" --bindir="${SRC}/bin" --enable-pic --enable-shared --disable-cli && \
        make && \
        make install && \
        rm -rf ${DIR} && \
        # x265 http://www.videolan.org/developers/x265.html
        DIR=$(mktemp -d) && cd ${DIR} && \
        echo "**** COMPILING x265 ****" && \
        git clone https://bitbucket.org/multicoreware/x265_git.git . && \
        git checkout bc6dcd09508c352453adf0cc73d70bb1aa1d5b62 && \
        cd build && cmake ../source && \
        make -j$(nproc) && \
        make install && \
        rm -rf ${DIR} && \
        DIR=$(mktemp -d) && cd ${DIR} && \
        echo "**** COMPILING libfdk_aac ****" && \
        git clone --depth 1 https://github.com/mstorsjo/fdk-aac.git . && \
        autoreconf -fiv && \
        ./configure --prefix="${SRC}" --enable-pic --enable-shared && \
        make -j$(nproc) && \
        make install && \
        rm -rf ${DIR}


COPY    *.patch /root/

## ffmpeg source from github
# commit 263b98bbbda2594c44e7bf5326433d18b132f7d6 from 29/11/2020
# commit ca21cb1e36ccae2ee71d4299d477fa9284c1f551 from 12/01/2021
# git checkout --detach ca21cb1e36ccae2ee71d4299d477fa9284c1f551 && \
RUN     DIR=$(mktemp -d) && cd ${DIR} && \
        git clone --depth 1 https://github.com/ffmpeg/FFmpeg.git . && \
        cp /root/*.patch . && \
        git apply -v *.patch && \
        ./configure --prefix="${SRC}" \
        --extra-cflags="-I${SRC}/include" \
        --extra-ldflags="-L${SRC}/lib" \
        --extra-libs="-lpthread -lm" \
        --bindir="${SRC}/bin" \
        --disable-doc \
        --disable-static \
        --enable-shared \
        --enable-pic \
        --disable-ffplay \
        --extra-libs=-ldl \
        --enable-version3 \
        --enable-libx264 \
        --enable-libx265 \
        --enable-libfdk-aac \
        --enable-libfontconfig \
        --enable-libfreetype \
        --enable-libharfbuzz \
        --enable-gpl \
        --enable-nonfree \
        --disable-debug \
        --enable-openssl && \
        make && \
        make install && \
        make distclean && \
        hash -r && \
        rm -rf ${DIR} && \
        cd && \
        apk del ${buildDeps} && \
        rm -rf /var/cache/apk/* /usr/local/include && \
        ffmpeg -buildconf


COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY entrypoint.py /usr/local/bin/entrypoint.py

RUN chmod +x /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.py


ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
