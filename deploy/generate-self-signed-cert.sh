#!/bin/sh
# 给 nginx-tls profile 生成一张自签证书。参数是访问时用的 IP 或域名。
#
#   ./deploy/generate-self-signed-cert.sh 111.229.172.59
#   ./deploy/generate-self-signed-cert.sh skyland.example.com
#
# 自签证书浏览器会弹一次「不安全」警告，点继续之后就是安全上下文，
# crossOriginIsolated 为 true，功能完整。适合内测，不适合对外。
set -eu

host="${1:-}"
if [ -z "$host" ]; then
  echo "用法: $0 <IP 或域名>" >&2
  exit 1
fi

# IP 必须写进 subjectAltName 的 IP: 段，写成 DNS: 部分浏览器不认。
case "$host" in
  *[!0-9.]*) san="DNS:$host" ;;
  *)         san="IP:$host" ;;
esac

dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)/tls"
mkdir -p "$dir"

openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
  -keyout "$dir/key.pem" -out "$dir/cert.pem" \
  -subj "/CN=$host" -addext "subjectAltName=$san"

chmod 600 "$dir/key.pem"
echo "已生成 $dir/cert.pem 与 $dir/key.pem（CN=$host, SAN=$san）"
