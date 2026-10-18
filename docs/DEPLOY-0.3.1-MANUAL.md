# 把 150.158.38.174 更到 0.3.1（在服务器上跑）

代码已经推到 `master` 了（`9c9cd95f`，是 `7ca079bd` 的**快进**），只差服务器把工作区拉过去 + 重启。

## 一次性：装上定时器（以后就不用再手动）

```bash
cd <游戏检出目录>          # 例如 /home/ubuntu/webUI/Stronghold-Protocol
sudo deploy/install.sh --mode timer \
     --repo "$(pwd)" \
     --remote https://gh-proxy.com/https://github.com/lilyco-42/Stronghold-Protocol.git \
     --branch master
sudo deploy/install.sh --status
```

装完之后每 2 分钟自己拉一次；`deploy.sh` 会先发游戏内维护公告、等 60 秒、再重启，
重启后轮询 `/healthz` 核对版本与在线人数，然后撤下公告。**这是两条自动部署路径里更稳的一条**
（push 钩子模式失败会自动回滚，定时器模式失败则停在已更新的工作区等人处理）。

## 或者这一次手动跑

```bash
cd <游戏检出目录>
sudo /usr/local/bin/stronghold-deploy.sh --dry-run    # 先看它要做什么（exit 2 = 什么都没做）
sudo /usr/local/bin/stronghold-deploy.sh --remote https://gh-proxy.com/https://github.com/lilyco-42/Stronghold-Protocol.git --lead 60
```

`/usr/local/bin/stronghold-deploy.sh` 没装的话，等价的手工三步：

```bash
cd <游戏检出目录>
git fetch origin && git merge --ff-only origin/master   # 7ca079bd -> 9c9cd95f
npm ci --omit=dev                                        # vite 之类改动时才有必要
sudo systemctl restart stronghold && sleep 6 && curl -s localhost:3000/healthz
```

## 验收

```bash
curl -s http://150.158.38.174:3000/healthz | head -c 200
# 期望 "app":"0.3.1"
```

失败回滚：`git reset --hard 7ca079bd && sudo systemctl restart stronghold`
