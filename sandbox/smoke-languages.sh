#!/bin/sh
set -eu
umask 077

language=${1:?pass one language: c cpp java lua node typescript python php go rust dart ruby shell}
work=$(mktemp -d /workspace/.qfli-smoke.XXXXXXXX)
trap 'rm -rf -- "$work"' EXIT
cd "$work"

expect() {
  output=$("$@")
  if [ "$output" != 'qfli-toolchain-ok' ]; then
    printf 'Unexpected %s output: %s\n' "$language" "$output" >&2
    exit 1
  fi
}

case "$language" in
  c)
    printf '%s\n' '#include <stdio.h>' 'int main(void) { puts("qfli-toolchain-ok"); return 0; }' > main.c
    gcc -Wall -Wextra -Werror main.c -o program
    expect ./program
    ;;
  cpp)
    printf '%s\n' '#include <iostream>' 'int main() { std::cout << "qfli-toolchain-ok\n"; }' > main.cpp
    g++ -Wall -Wextra -Werror main.cpp -o program
    expect ./program
    ;;
  java)
    printf '%s\n' 'class Main { public static void main(String[] args) { System.out.println("qfli-toolchain-ok"); } }' > Main.java
    javac Main.java
    expect java Main
    mvn --version >/dev/null
    ;;
  lua)
    printf '%s\n' 'print("qfli-toolchain-ok")' > main.lua
    expect lua main.lua
    luarocks --version >/dev/null
    ;;
  node)
    printf '%s\n' 'console.log("qfli-toolchain-ok");' > main.js
    expect node main.js
    npm --version >/dev/null
    ;;
  typescript)
    # The App runs .ts entries with Node's built-in transform, not tsc.
    printf '%s\n' 'enum Status { Ok = "qfli-toolchain-ok" }' \
      'const message: string = Status.Ok;' 'console.log(message);' > main.ts
    expect node --experimental-transform-types --disable-warning=ExperimentalWarning main.ts
    ;;
  python)
    printf '%s\n' 'print("qfli-toolchain-ok")' > main.py
    python3 -m venv venv
    expect venv/bin/python main.py
    venv/bin/python -m pip --version >/dev/null
    ;;
  php)
    printf '%s\n' '<?php echo "qfli-toolchain-ok\n";' > main.php
    expect php main.php
    composer --version >/dev/null
    ;;
  go)
    export GOCACHE="$work/go-cache"
    printf '%s\n' 'package main' 'import "fmt"' 'func main() { fmt.Println("qfli-toolchain-ok") }' > main.go
    go build -o program main.go
    expect ./program
    ;;
  rust)
    printf '%s\n' 'fn main() { println!("qfli-toolchain-ok"); }' > main.rs
    rustc main.rs -o program
    expect ./program
    mkdir -p src
    cp main.rs src/main.rs
    printf '%s\n' '[package]' 'name = "qfli-smoke"' 'version = "0.1.0"' 'edition = "2021"' > Cargo.toml
    cargo build --offline
    expect ./target/debug/qfli-smoke
    ;;
  dart)
    printf '%s\n' 'void main() { print("qfli-toolchain-ok"); }' > main.dart
    expect dart main.dart
    dart compile exe main.dart -o program >/dev/null
    expect ./program
    ;;
  ruby)
    printf '%s\n' 'puts "qfli-toolchain-ok"' > main.rb
    expect ruby main.rb
    ;;
  shell)
    printf '%s\n' 'set -eu' 'value=qfli-toolchain-ok' 'printf "%s\n" "$value"' > main.sh
    expect bash main.sh
    ;;
  *)
    printf 'Unsupported language: %s\n' "$language" >&2
    exit 2
    ;;
esac
printf 'PASS %s\n' "$language"
