ARG BASE_IMAGE=debian:bookworm-slim
FROM ${BASE_IMAGE}

ARG DEBIAN_MIRROR=http://deb.debian.org

LABEL io.qfli.terminal.image="1"

RUN case "$DEBIAN_MIRROR" in http://*|https://*) ;; *) exit 1 ;; esac \
    && sed -i "s|http://deb.debian.org|${DEBIAN_MIRROR%/}|g" /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        -o Acquire::Retries=2 -o Acquire::ForceIPv4=true update \
    && apt-get -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
        -o Acquire::Retries=2 -o Acquire::ForceIPv4=true install -y --no-install-recommends \
        ca-certificates python3 nodejs gcc g++ make git lua5.4 openjdk-17-jdk-headless \
    && rm -rf /var/lib/apt/lists/* \
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} + \
    && mkdir -p /usr/local/lib/qfli /workspace \
    && chmod 0755 /usr/local/lib/qfli /workspace

COPY --chown=0:0 --chmod=0444 init.py cleanup.py ready.py snapshot.py /usr/local/lib/qfli/

ENV HOME=/workspace \
    PATH=/usr/local/bin:/usr/bin:/bin \
    TERM=xterm-256color \
    LANG=C.UTF-8

WORKDIR /workspace
USER 65532:65532
ENTRYPOINT ["/usr/bin/python3", "-I", "/usr/local/lib/qfli/init.py"]
CMD []
