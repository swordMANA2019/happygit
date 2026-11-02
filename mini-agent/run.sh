# 把上面的文件按目录放好
#npm install
#cp .env.example .env   # 填入你的 key

# 单次任务
#npm run dev -- "给这个项目加一个 README，说明如何启动"

# 交互模式
#npm run dev

rm -rf bun*

bun install                      # 复用 package-lock 没问题

bun build ./src/index.ts \
  --compile \
  --outfile mini-agent \
  --target=bun

