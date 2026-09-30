ARG BASE_IMAGE=debian:trixie-slim
FROM ${BASE_IMAGE}

ARG DEBIAN_MIRROR=http://deb.debian.org
ARG NODE_VERSION=24.15.0
ARG NODE_SHA256=472655581fb851559730c48763e0c9d3bc25975c59d518003fc0849d3e4ba0f6
ARG DART_VERSION=3.13.5
ARG DART_SHA256=ea864bc64df30a6b8bdf30b2e32550f7717d9a890de8f40293aeabb924fe232b

LABEL io.qfli.terminal.image="1" io.qfli.terminal.toolchains="2"

RUN apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        -o Acquire::Retries=2 -o Acquire::ForceIPv4=true --error-on=any update \
    && apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        -o Acquire::Retries=2 -o Acquire::ForceIPv4=true install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN case "$DEBIAN_MIRROR" in http://*|https://*) ;; *) exit 1 ;; esac \
    && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR%/}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        -o Acquire::Retries=2 -o Acquire::ForceIPv4=true --error-on=any update \
    && apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        -o Acquire::Retries=2 -o Acquire::ForceIPv4=true install -y --no-install-recommends \
        ca-certificates build-essential cmake pkg-config git curl unzip xz-utils \
        python3 python3-pip python3-venv python-is-python3 php-cli composer \
        golang-go rustc cargo lua5.4 luarocks openjdk-21-jdk-headless maven \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /opt/node \
    && (curl --fail --location --ipv4 --tls-max 1.2 --retry 2 --retry-all-errors --retry-max-time 90 \
        --speed-limit 131072 --speed-time 30 --connect-timeout 15 --max-time 300 \
        --output /tmp/node.tar.xz \
        "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
        || curl --fail --location --ipv4 --tls-max 1.2 --retry 2 --retry-all-errors --retry-max-time 90 \
        --speed-limit 131072 --speed-time 30 --connect-timeout 15 --max-time 300 \
        --output /tmp/node.tar.xz \
        "https://npmmirror.com/mirrors/node/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz") \
    && echo "${NODE_SHA256}  /tmp/node.tar.xz" | sha256sum -c - \
    && tar -xJf /tmp/node.tar.xz --strip-components=1 -C /opt/node \
    && rm -f /tmp/node.tar.xz

RUN (curl --fail --location --ipv4 --tls-max 1.2 --retry 2 --retry-all-errors --retry-max-time 90 \
        --speed-limit 524288 --speed-time 30 --connect-timeout 15 --max-time 600 \
        --output /tmp/dart.zip \
        "https://storage.googleapis.com/dart-archive/channels/stable/release/${DART_VERSION}/sdk/dartsdk-linux-x64-release.zip" \
        || curl --fail --location --ipv4 --tls-max 1.2 --retry 2 --retry-all-errors --retry-max-time 90 \
        --speed-limit 524288 --speed-time 30 --connect-timeout 15 --max-time 600 \
        --output /tmp/dart.zip \
        "https://storage.flutter-io.cn/dart-archive/channels/stable/release/${DART_VERSION}/sdk/dartsdk-linux-x64-release.zip") \
    && echo "${DART_SHA256}  /tmp/dart.zip" | sha256sum -c - \
    && unzip -q /tmp/dart.zip -d /opt \
    && rm -f /tmp/dart.zip \
    && ln -s /usr/bin/lua5.4 /usr/local/bin/lua \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
    && mkdir -p /usr/local/lib/qfli /workspace \
    && chmod 0755 /usr/local/lib/qfli /workspace

COPY --chown=0:0 --chmod=0444 init.py cleanup.py ready.py snapshot.py /usr/local/lib/qfli/
COPY --chown=0:0 --chmod=0555 smoke-languages.sh /usr/local/lib/qfli/

ENV HOME=/workspace \
    TMPDIR=/workspace/.tmp \
    PATH=/opt/node/bin:/opt/dart-sdk/bin:/usr/local/bin:/usr/bin:/bin \
    TERM=xterm-256color \
    LANG=C.UTF-8

WORKDIR /workspace
USER 65533:65533
ENTRYPOINT ["/usr/bin/python3", "-I", "/usr/local/lib/qfli/init.py"]
CMD []
