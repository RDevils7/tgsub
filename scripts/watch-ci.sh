#!/usr/bin/env bash
# 等待 GitHub Actions run 完成（Docker 镜像工作流）
RUN_ID="$1"
API="https://api.github.com/repos/RDevils7/tgsub/actions/runs/${RUN_ID}"
MAX=40   # 最多轮询 40 次，每次 30 秒 ≈ 20 分钟

for i in $(seq 1 $MAX); do
  body=$(curl -s -m 20 "$API")
  status=$(echo "$body" | python -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null)
  concl=$(echo "$body" | python -c "import sys,json; print(json.load(sys.stdin).get('conclusion',''))" 2>/dev/null)
  printf "[%2d] status=%s conclusion=%s\n" "$i" "$status" "$concl"
  if [ "$status" = "completed" ]; then
    echo "=== 最终结论: $concl ==="
    echo "--- 各 job 状态 ---"
    echo "$body" | python -c "
import sys,json
d=json.load(sys.stdin)
print('run:', d.get('name'), '| head_sha:', d.get('head_sha','')[:7])
print('html_url:', d.get('html_url'))
" 2>/dev/null
    exit 0
  fi
  sleep 30
done
echo "=== 等待超时，run 仍未完成 ==="
