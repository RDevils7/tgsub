#!/usr/bin/env bash
# 校验 GHCR 上的镜像是否可以匿名拉取（公开包无需 docker login）
#
# 用法: bash scripts/check-ghcr.sh [镜像地址] [标签]
#   镜像地址默认 ghcr.io/rdevils7/tgsub，标签默认 latest
#   需要代理时设置环境变量 GHCR_PROXY，例如 GHCR_PROXY=http://192.168.5.2:7890
set -u
IMAGE="${1:-ghcr.io/rdevils7/tgsub}"
TAG="${2:-latest}"
REPO="${IMAGE#ghcr.io/}"
PROXY="${GHCR_PROXY:-}"

CURL="curl -s -m 25"
if [ -n "$PROXY" ]; then
  CURL="curl -s -m 25 -x $PROXY"
fi

echo "== 1. 匿名取 token（公开包可直接拿） =="
TOKEN=$($CURL "https://ghcr.io/token?scope=repository:${REPO}:pull&service=ghcr.io" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).token||'')}catch{console.log('')}})")

if [ -z "$TOKEN" ]; then
  echo "✗ 匿名取 token 失败：包可能是私有的，需要 docker login ghcr.io -u <用户名>（PAT 勾选 read:packages）"
  exit 1
fi
echo "✓ 已拿到匿名 token，说明该镜像可公开拉取"

echo "== 2. 列出全部标签 =="
$CURL -H "Authorization: Bearer $TOKEN" "https://ghcr.io/v2/${REPO}/tags/list" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);console.log('标签:',(j.tags||[]).join(', ')||'(空)')}catch{console.log('响应:',s.slice(0,200))}})"

echo "== 3. 读取 $TAG 的 manifest =="
$CURL -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json" \
  "https://ghcr.io/v2/${REPO}/manifests/$TAG" \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{
      try{
        const j=JSON.parse(s);
        if(j.manifests){console.log('✓ 多架构 manifest，平台:',j.manifests.map(m=>m.platform?.os+'/'+m.platform?.architecture).join(', '))}
        else if(j.mediaType){console.log('✓ 单架构 manifest:',j.mediaType)}
        else console.log('响应:',JSON.stringify(j).slice(0,300));
      }catch{console.log('响应:',s.slice(0,200))}})"

echo "== 4. 提示 =="
echo "docker pull ${IMAGE}:${TAG}"
