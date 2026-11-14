---
title: 从零搭建DOMjudge：XCPC校赛技术筹备指南
date: 2026-08-23 22:19:29
tags: 
  - 教程
  - ACM
  - 办赛
categories:
  - XCPC办赛
description: 一篇关于XCPC办赛的教学
cover: /images/少女.jpg
abbrlink: xcpc-campus-contest-technically

---

# 从零搭建DOMjudge：XCPC校赛技术筹备指南

> 不只是教你装软件，更是为了让你**顺利办完一场比赛**

DOMjudge 是举办编程比赛（比如ACM校赛、XCPC选拔赛）最靠谱的系统之一。选手登录网页提交代码，系统自动评测并实时显示排名——但要把这套系统从零跑起来，中间有不少“隐形”的坑。

这篇文章会带你**从买服务器开始，一路部署到赛后滚榜**。我们使用 Docker Compose 来统一编排所有服务，**全程复制粘贴命令即可，不需要你写一行代码**（除了复制我们写好的配置文件）。

---

## 🎯 写在前面：这不只是装一个软件

很多教程只教你怎么把DOMjudge页面跑起来，但办赛真正的技术挑战往往在别处：

- 比赛时选手交代码卡死怎么办？
- 评测机（Judgehost）没启动，谁来判题？
- 颁奖时滚榜工具连不上数据怎么办？

这篇文章的目标是：**让你部署的不只是一个空壳，而是一套能真正跑完一场比赛的系统。**

---

## 📚 赛前准备：你具备这些条件吗？

动手之前，先确认你准备好了几件事：

### 你需要有的基础知识

- 能看懂简单的Linux命令（`ls`、`cd`、`apt`这类）
- 知道什么是IP地址和端口号
- 遇到报错愿意复制错误信息去问一下大D老师

### 你需要想清楚的几个问题

| 问题                 | 说明                                         |
| :------------------- | :------------------------------------------- |
| **比赛规模多大？**   | 几十人用2核4G够，上百人建议4核8G以上         |
| **选手怎么访问？**   | 校内局域网（用内网IP）还是公网（需要带宽）？ |
| **要不要滚榜？**     | 要颁奖仪式的话，必须提前测试好`icpctools`    |
| **谁负责技术支持？** | 比赛当天最好有人盯着服务器和网络             |

---

## 💻 第一步：购买服务器（选对系统是成败关键！）

就像开网店需要租仓库，部署DOMjudge必须有一台云服务器。

### 去哪买？

推荐 **阿里云**、**腾讯云** 或 **Azure学生订阅**，国内访问快，学生优惠也不少。

### 买什么样的配置？

| 配置项       | 建议（小型比赛<100人）                       |
| :----------- | :------------------------------------------- |
| CPU          | 2核                                          |
| 内存         | 4 GB（2GB勉强够，但数据库+评测同时跑容易崩） |
| 硬盘         | 40 GB                                        |
| **操作系统** | **Ubuntu 22.04 LTS（必须！千万别选24.04）**  |

> ⚠️ **致命警告**：为什么必须选Ubuntu 22.04？  
> 因为DOMjudge的评测组件依赖Linux的 **cgroup v1** 来隔离和限制评测进程的资源。Ubuntu 24.04默认移除了cgroup v1，改用cgroup v2，会导致judgehost根本无法启动，报错 `cgroup mounting failed`。  
> 如果你手快已经装了24.04，必须使用DOMjudge 8.3.1及以上版本并额外配置cgroup v2支持——**但新手强烈建议直接重装22.04，省去无穷无尽的麻烦**。  
> 另外，本教程后面会把 DOMjudge 镜像**固定为 8.3.1**：`latest` 是滚动标签，会一路升到 9.x，而新版对 cgroup 的要求一直在变（主线手册已明确 cgroup v1 不再支持），哪天重建容器就可能让这套 22.04 + cgroup v1 的配置突然失效。具体原因见第五步"坑 2"。

### 买好之后你得到什么？

- 一个 **公网IP地址**（如 `123.45.67.89`）
- 一个 **root密码**（请用**纸笔**记下来，别存手机备忘录）

### 选服务器还要注意什么？（实战经验）

- **带宽**：如果用公网，建议选**5Mbps以上**带宽。比赛时几十个选手同时刷新榜单、提交代码，带宽太小直接卡死。而且注意云服务商的风控，流量突增可能被误判攻击而封IP，提前联系客服报备。
- **网络连通性**：确保选手能Ping通你的服务器IP。
- **多机公平**：如果你规模大到要用多台评测机（judgehost），务必保证它们的CPU、内存配置**一模一样**，否则同样的代码在不同机器上跑出的时间可能不同，引发公平性质疑。

---

## 🔌 第二步：SSH连接到服务器

服务器在云端，你需要在本地电脑上远程操作。

**Windows用户：**

1. 按下 `Win + R`，输入 `cmd`，回车打开命令提示符。

2. 输入命令（IP换成你自己的）：

   ```bash
   ssh root@123.45.67.89
   ```

3. 第一次连接提示 `Are you sure you want to continue connecting?`，输入 `yes` 回车。

4. 提示输入密码时，**直接输入你的root密码**（屏幕上不会显示任何字符，这是正常的！），输完回车。

如果看到 `root@your-server:~#` 这样的提示符，说明登录成功了！

---

## 🧰 第三步：安装Docker和Docker Compose

现在服务器还是“毛坯房”，我们先装Docker和Docker Compose。

**依次执行以下命令（每输完一条按回车）：**

```bash
# 命令1：更新软件源列表
apt update
```

```bash
# 命令2：官方一键安装脚本（等1-2分钟）
curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh
```

安装完成后验证一下：

```bash
docker --version
```

如果看到 `Docker version 24.x.x` 之类的信息，就成功了。

---

## 🚀 第四步：配置镜像加速器（省时间的关键）

Docker默认从国外仓库下载镜像，慢得想哭。配置国内镜像源能提速10倍以上。

**复制以下整段命令，粘贴到终端一次性执行：**

```bash
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{
  "registry-mirrors": ["https://docker.1panel.live"]
}
EOF
systemctl restart docker
```

如果以后这个镜像地址失效了，可以换成 `https://hub-mirror.c.163.com`。

---

## 📄 第五步：编写 Docker Compose 配置文件

我们使用 Docker Compose 来统一管理所有服务（数据库、DOMserver、Judgehost），这样比逐条输入 `docker run` 命令更清晰、更易维护，也方便以后扩展。

**创建一个专门的工作目录并进入：**

```bash
mkdir -p ~/domjudge
cd ~/domjudge
```

**创建并编辑 `docker-compose.yml` 文件：**

```bash
nano docker-compose.yml
```

将以下内容**完整复制**到文件中（**注意**：请把 `CHANGE_ME_root_password`、`CHANGE_ME_domjudge_password` 和 `JUDGEDAEMON_PASSWORD` 换成**你自己生成的强密码**，见后续步骤。文中出现的所有口令都只是占位符，切勿原样照抄，也不要把真实口令写进任何公开文章或仓库）：

```yaml
services:
  # MariaDB 数据库（10.11 LTS，官方镜像自带 healthcheck.sh）
  mariadb:
    image: mariadb:10.11
    container_name: dj-mariadb
    environment:
      - MYSQL_ROOT_PASSWORD=CHANGE_ME_root_password
      - MYSQL_USER=domjudge
      - MYSQL_PASSWORD=CHANGE_ME_domjudge_password
      - MYSQL_DATABASE=domjudge
    command: --max-connections=1000
    volumes:
      - mariadb_data:/var/lib/mysql
    networks:
      - domjudge
    restart: unless-stopped
    healthcheck:          # 必须有！domserver 的 service_healthy 依赖它
      test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"]
      interval: 5s
      timeout: 5s
      retries: 12
      start_period: 60s   # 首次初始化数据卷较慢，给足宽限期

  # DOMjudge 主服务 (DOMserver)
  domserver:
    image: domjudge/domserver:8.3.1   # 固定版本，不要用 latest
    container_name: domserver
    environment:
      - MYSQL_HOST=mariadb
      - MYSQL_USER=domjudge
      - MYSQL_PASSWORD=CHANGE_ME_domjudge_password
      - MYSQL_DATABASE=domjudge
      - MYSQL_ROOT_PASSWORD=CHANGE_ME_root_password
      - CONTAINER_TIMEZONE=Asia/Shanghai
      - SKIP_EXAMPLE_DATA=1   # 跳过示例数据导入，避免内存不足超时
    ports:
      - "12345:80"
    depends_on:
      mariadb:
        condition: service_healthy
    networks:
      - domjudge
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost/"]
      interval: 10s
      timeout: 5s
      retries: 10
      start_period: 60s   # 首次启动要建表，别被提前判成 unhealthy

  # 评测机 (Judgehost)
  judgehost-0:
    image: domjudge/judgehost:8.3.1   # 必须与 domserver 同版本
    container_name: judgehost-0
    privileged: true
    hostname: judgedaemon-0
    volumes:
      - /sys/fs/cgroup:/sys/fs/cgroup   # 注意：不是 :ro，需要读写权限
    networks:
      - domjudge
    depends_on:
      domserver:
        condition: service_healthy
    environment:
      - CONTAINER_TIMEZONE=Asia/Shanghai
      - DOMSERVER_BASEURL=http://domserver/
      - DAEMON_ID=0
      - JUDGEDAEMON_PASSWORD=你的JUDGEDAEMON_PASSWORD   # 请替换为实际密码
    restart: unless-stopped

networks:
  domjudge:
    driver: bridge

volumes:
  mariadb_data:
```

> ⚠️ **重要**：`JUDGEDAEMON_PASSWORD` 需要从 domserver 容器中获取，先不要着急启动，看下一步。

> 🐛 **坑 1：`service_healthy` 不会自动帮你生成健康检查**
>
> `domserver.depends_on.mariadb.condition: service_healthy` 的意思是"等数据库真的健康了再启动"，但 Compose 只是去读被依赖服务的 `healthcheck`，**不会替你补一个**。如果 mariadb 没写 `healthcheck`，`docker compose up -d` 会直接失败，报类似 `container for service "mariadb" has no healthcheck configured`（不同 Compose 版本措辞略有差异，也可能是 `service "mariadb" is missing a healthcheck configuration`），domserver 根本起不来。
>
> **为什么用 `healthcheck.sh` 而不是 `mysqladmin ping`**：`mariadb:10.11` 官方镜像自带 `healthcheck.sh`（在 PATH 里，不用额外装工具），`--connect` 确认 TCP 可连、`--innodb_initialized` 确认 InnoDB 完成初始化（含崩溃恢复），这正是 domserver 建表、导入数据所必需的"真就绪"。而 `mysqladmin ping` 在数据库初始化阶段（先以 `--skip-networking` 启动、再重启）就可能返回成功，会让 domserver 连上一个还没准备好的库；从 MariaDB 11.0 起镜像更是直接移除了 `mysqladmin`。`start_period: 60s` 则是给首次创建数据卷留的宽限期，冷启动慢一点不会被判 `unhealthy` 而把 domserver 永远卡住。
>
> 上面 domserver 自己的 `healthcheck` 同理加了 `start_period`：它要建表，首次启动常常要几十秒，而 judgehost 也在等它 `healthy`。如果 `docker compose ps` 里 domserver 一直是 `(health: starting)`，先用 `docker exec domserver command -v curl` 确认镜像里有 curl（有些精简镜像没有），再 `docker inspect --format '{{json .State.Health}}' domserver` 看探测输出。

> 🐛 **坑 2：镜像版本必须钉死，而且两个组件要一致**
>
> `domjudge/domserver:latest` 和 `domjudge/judgehost:latest` 都是滚动标签。某天重建容器或 `docker compose pull` 之后，服务端可能悄悄升到 9.x、评测机还是旧版（或反过来），REST API 不兼容会让评测机连不上、提交全部卡在 `Pending`；新版对 cgroup 的要求也在变（DOMjudge 主线手册已写明 cgroup v1 不再支持），和本文 Ubuntu 22.04 + cgroup v1 的路线未必兼容。所以这里固定为 **`8.3.1`**：`domserver` 与 `judgehost` 必须写同一个版本号，要升级就两个一起改、一起重测（包括第一步提到的 24.04 + cgroup v2 路线，换版本后也要重新验证）。`mariadb:10.11` 已经钉在 LTS 系列上，需要完全可复现时可以再钉到具体补丁版本或镜像 digest。

---

## 🔑 第六步：获取 JUDGEDAEMON_PASSWORD

我们需要先临时启动 `mariadb` 和 `domserver`，从 domserver 容器中获取 `restapi.secret` 密码：

```bash
# 先只启动数据库和 domserver（Compose 会等 mariadb healthy 才创建 domserver）
docker compose up -d mariadb domserver

# 确认数据库健康检查真的通过了
docker compose ps
docker inspect --format '{{.State.Health.Status}}' dj-mariadb   # 输出 healthy 才继续

# 别用固定 sleep，轮询等 domserver 把密钥文件生成出来（最多等 5 分钟）
for i in $(seq 1 60); do
  docker exec domserver cat /opt/domjudge/domserver/etc/restapi.secret >/dev/null 2>&1 && break
  echo "等待 domserver 初始化（$i/60）..."; sleep 5
done

# 获取 restapi 密钥
docker exec domserver cat /opt/domjudge/domserver/etc/restapi.secret
```

你会看到类似这样的输出：
```
http://domserver/ admin 4b2f8d9e7a1c3f5d
```

其中的 **最后一个字段**（如 `4b2f8d9e7a1c3f5d`）就是 `JUDGEDAEMON_PASSWORD`。**复制它**。

---

## 📝 第七步：更新 Compose 文件并启动所有服务

重新编辑 `docker-compose.yml`，将 `JUDGEDAEMON_PASSWORD` 替换为实际密码：

```bash
nano docker-compose.yml
```

找到 `judgehost-0` 的环境变量部分，将 `你的JUDGEDAEMON_PASSWORD` 替换为刚才获取的密码。

保存并退出后，停止之前的临时容器，启动所有服务：

```bash
docker compose down
docker compose up -d
```

查看所有容器状态：

```bash
docker compose ps
```

你应该看到三个容器全部 `Up`，其中 `dj-mariadb` 和 `domserver` 会额外显示 `(healthy)`——这是 `depends_on: service_healthy` 生效的标志。judgehost 只有在 domserver 变成 healthy 之后才会被创建；如果它迟迟不出现，按下面"常见问题"里的健康检查排错步骤查。

---

## 🔑 第八步：获取管理员初始密码

DOMjudge会随机生成一个管理员密码，执行以下命令获取：

```bash
docker exec domserver cat /opt/domjudge/domserver/etc/initial_admin_password.secret
```

屏幕上会出现一串乱码似的字符（形如 `xK9mQ2vT7p`），**立刻记下来！** 这是你登录后台的唯一钥匙。

> 💡 **如果这个文件不存在或密码无效**，可以使用以下命令重置 admin 密码：
> ```bash
> docker exec -it domserver /opt/domjudge/domserver/webapp/bin/console domjudge:reset-user-password admin
> ```

---

## 🌐 第九步：访问与测试

### 首先检查防火墙（端口放行）

如果你的云服务器页面打不开，**99%是因为安全组没放行端口**。去阿里云/腾讯云/Azure控制台找到“安全组”或“防火墙”或“网络安全组”：

- 添加**入方向**规则：
  - 端口：`12345`
  - 协议：`TCP`
  - 源IP：`0.0.0.0/0`（允许所有IP访问）

### 访问管理后台

打开浏览器输入：

```
http://你的服务器IP:12345/jury
```

例如 `http://123.45.67.89:12345/jury`

- 用户名：`admin`
- 密码：第八步记下来的那串字符

如果看到DOMjudge的仪表盘，恭喜！核心系统跑通了。

### 🧪 赛前压测：别只测"正确提交"

能判对一道题，只证明主链路通了。比赛当天真正容易出事的是**异常提交**：编译错误会不会拖垮评测队列、超时程序会不会卡住 judgehost、内存超限能不能被拦下并给出正确结果。所以彩排至少要把下面这些结果都跑一遍。

**准备工作**：在后台建一道最简单的题（例如 A+B），配好至少一组测试数据，再建几个测试队伍账号。为了快速触发内存超限，压测时把限制临时调小：

- 单题内存限制：`Problems → 编辑题目 → Memlimit`（单位 kB）
- 全局内存限制：`Configuration settings → memory_limit`（单位 kB，默认约 2 GB，可被单题覆盖）
- 时限用 `Timelimit` 调到 1s 即可；**正式比赛前记得把这两项改回真实值**。

选手入口 `http://你的服务器IP:12345/team`，用测试队伍账号提交，观察状态 `Pending` → `Running` → 最终结果。如果一直是 `Pending`，检查 judgehost 是否启动成功（`docker compose ps judgehost-0`、`docker compose logs judgehost-0`）。

| # | 构造方式 | 期望结果 | 重点检查 |
| :-- | :-- | :-- | :-- |
| 1 | 正确解法 | `CORRECT` | 榜单 solved +1、罚时正确 |
| 2 | 语法错误 | `COMPILER-ERROR` | 提交详情能看到编译报错；默认 `compile_penalty=false` **不计罚时**，赛制若要求计入需改配置 |
| 3 | 死循环 | `TIMELIMIT` | 进程被按时杀掉、队列继续处理下一发，judgehost 没卡死 |
| 4 | 疯狂申请并写入内存 | `RUN-ERROR`（内部 `memory-limit`） | 见下方说明；cgroup 真的拦住了、宿主机内存没被吃满 |
| 5 | 除零等非 0 退出 | `RUN-ERROR` | 退出码判定生效 |
| 6 | 输出错误 / 不输出 / 疯狂输出 | `WRONG-ANSWER` / `NO-OUTPUT` / `OUTPUT-LIMIT` | 榜单计罚是否符合赛制 |
| 7 | 多个队伍短时间批量提交 | 每一发都走完整个流程 | 不丢单、judgehost 不反复重启；jury、选手页、榜单、event-feed 四处结果一致 |

> ⚠️ **关于"内存超限"**：DOMjudge 不像部分 OJ 那样给选手显示固定的 `MLE` 标签。官方选手手册明确写着"试图使用超过限制的内存，程序多半会中止并记为 run error"；而内部结果类型里确实有 `memory-limit`（可在 jury 的提交详情、runguard 输出里看到线索）。所以验收标准是**"这发提交被及时终止、判为非正确、且没拖垮服务器"**，而不是死等页面上出现 `MLE` 三个字母。

四份最常用的 C++ 测试代码。文件名建议用 `A.cpp`（`A` 换成题目短名），或在网页提交时手动选好题目和语言——`ce.cpp` 这种名字 DOMjudge 会当成题目名去猜，容易选错题：

```cpp
// 用例1：编译错误
int main() { this is not c++; }
```

```cpp
// 用例2：超时（volatile 防止被编译器优化掉）
int main() {
    volatile long long x = 0;
    for (;;) { x++; }
}
```

```cpp
// 用例3：内存超限（持续申请并真正写入内存）
#include <cstdlib>
#include <cstring>
int main() {
    const size_t MB = 1024 * 1024;
    for (;;) {
        char *p = (char *)malloc(MB);
        if (!p) break;
        memset(p, 1, MB);   // 只 malloc 不写，不会真正占用物理内存！
        // 故意不 free
    }
    return 0;
}
```

```cpp
// 用例4：运行错误（非 0 退出）
int main() {
    volatile int z = 0;
    return 1 / z;
}
```

压测时另开一个终端盯着日志和资源：

```bash
docker compose logs -f judgehost-0   # 看每发提交的评测结果
docker compose ps                    # mariadb / domserver 是否仍为 (healthy)
htop                                 # CPU、内存有没有被打满
```

**赛前压测 Checklist**

- [ ] 上面 7 类场景全部判出结果，jury 里能看到对应 verdict
- [ ] 超时、内存超限的进程被及时杀掉，宿主机没被拖垮，评测队列没有积压不消
- [ ] `docker compose ps` 中 mariadb、domserver 仍是 `(healthy)`，judgehost 没有反复重启
- [ ] `docker compose down && docker compose up -d` 后能靠健康检查正常重新拉起
- [ ] 异常提交的罚时与榜单显示符合赛制（尤其 `compile_penalty`，默认关闭）
- [ ] 导出的 event-feed 里包含这些异常提交，可直接拿去做第十步的滚榜彩排

---

## 🧰 Docker Compose 常用管理命令

| 操作               | 命令                                                |
| :----------------- | :-------------------------------------------------- |
| 启动所有服务       | `docker compose up -d`                              |
| 停止所有服务       | `docker compose down`                               |
| 重启单个服务       | `docker compose restart judgehost-0`                |
| 查看所有容器状态   | `docker compose ps`                                 |
| 查看健康检查结果   | `docker inspect --format '{{json .State.Health}}' dj-mariadb` |
| 校验配置文件       | `docker compose config`                             |
| 查看实时日志       | `docker compose logs -f`                            |
| 查看某个服务的日志 | `docker compose logs judgehost-0`                   |
| 扩展现有多台评测机 | 复制 `judgehost-0` 配置块，修改容器名和 `DAEMON_ID` |

> 💡 **小提示**：如果未来比赛规模变大，你可以用同样的方式再添加 `judgehost-1`、`judgehost-2`，只需在 `docker-compose.yml` 中复制 `judgehost-0` 的配置块并修改容器名和 `DAEMON_ID`，然后 `docker compose up -d` 即可。它们会自动加入评测集群。**评测机数量不应超过 CPU 核心总数**。

---

## 🏁 第十步：赛后滚榜与收尾工作（办赛灵魂）

比赛结束**不是**停止评测就完了！颁奖仪式需要滚榜（Ranking Reveal）来炒热气氛——看着榜单从铜牌开始逐批揭晓，全场欢呼，这才是办赛的高光时刻。

DOMjudge官方推荐使用 **ICPC Tools** 套件中的 `Resolver` 工具进行滚榜。整个滚榜流程分为三步：**获取数据 → 生成奖项 → 运行滚榜**。

---

### 10.1 赛前准备：部署CDS（Contest Data Server）

CDS是ICPC Tools套件的核心数据中转站，Resolver和大屏幕都需要通过它获取DOMjudge的比赛数据。

#### ① 下载CDS

从 [ICPC Tools Releases](https://github.com/icpctools/icpctools/releases) 下载最新版的 `wlp.CDS-2.x.xxx.zip`。解压到服务器上。

> ⚠️ **关键提醒**：CDS与ICPC Tools（Resolver、Presentation等）**必须为同一版本**，否则可能无法正常运行！

#### ② 在DOMjudge中创建CDS专用用户

登录DOMjudge管理后台，创建一个新用户，授予以下权限：
- `API reader`（读取比赛数据）
- `API writer`（写入数据）
- `Source code reader`（读取代码，用于部分高级功能）

记下用户名和密码（后面配置CDS要用）。如果图省事，也可以直接使用 `admin` 账户。

#### ③ 获取比赛ID（CID）

登录DOMjudge管理后台，进入 `Contests` → `All available contests`，可以看到每场比赛的ID。记下来。

#### ④ 配置CDS

CDS的配置文件位于 `cds/usr/servers/cds/config/` 目录下，主要有两个：

**`cdsConfig.xml`**——CDS的外部配置，最关键的是修改 `<ccs>` 标签，填入DOMjudge的比赛API地址和刚才创建的用户名密码：

```xml
<ccs url="http://你的DOMjudge服务器IP/api/contests/比赛ID" 
     user="CDS用户名" 
     password="CDS密码" />
```

**`accounts.yaml`**——存储CDS各角色的账号密码，包括管理员（admin）、展示客户端用户（presentation）等。可以按需修改密码，**注意不要修改用户名**。

#### ⑤ 启动CDS

进入CDS目录，执行：

```bash
# 前台启动（方便看日志）
cds/bin/server run cds

# 后台启动（推荐）
cds/bin/server start cds
```

启动后，通过 `https://服务器IP:8443` 访问CDS的Web界面。刷新页面，如果看到变成了你配置的那场比赛，说明CDS已成功对接。

---

### 10.2 赛后：导出滚榜数据

比赛结束后，有两种方式获取滚榜数据：

#### 方式一：通过DOMjudge API直接下载（最简单）

在DOMjudge后台将比赛 **Finalize**（锁定最终榜单），然后访问以下地址下载数据文件：

```
http://你的DOMjudge服务器IP/api/v4/contests/比赛ID/event-feed?stream=false
```

下载后得到一个文件，重命名为 `event-feed.json` 或 `event-feed.ndjson`。

#### 方式二：通过CDS下载（推荐，数据更完整）

访问CDS的Web界面，找到对应比赛，点击“Event Feed”即可在浏览器中下载完整的event-feed文件。这种方式数据更全，包含队伍照片等信息。

> 💡 **小贴士**：如果想在滚榜时显示队伍照片和学校Logo，需要准备一个CDP文件夹，按以下结构存放图片：
> ```
> CDP/
> ├── event-feed.json          # 滚榜数据
> ├── teams/
> │   └── {队伍ID}/
> │       └── photo.jpg        # 选手照片
> └── organizations/
>  └── {学校ID}/
>      └── logo.jpg         # 学校Logo
> ```

---

### 10.3 配置奖项并生成滚榜文件

1. 进入ICPC Tools的 `Resolver` 文件夹，运行 `awards.bat`。
2. 在界面中选择数据源类型为 `event-feed`，加载刚才下载的 `event-feed.json` 文件。
3. 等待解析完成后，点击 **Medal** 设置金、银、铜牌各多少枚。
4. 将其他奖项（如最快解题奖、最佳女队奖等）设置为 `Others`，并选择 `Show as list`。
5. 点击 **Save event feed**，重新保存为一个新的json文件。

---

### 10.4 运行Resolver滚榜

在Resolver文件夹中打开终端（Windows下建议用 **Git Bash**，CMD可能不行），执行：

```bash
ICPC_FONT="Microsoft Yahei" ./resolver.bat 你保存的奖项文件.json
```

> ⚠️ **注意**：ICPC Tools默认使用西文字体，不支持显示中文，所以必须通过 `ICPC_FONT` 环境变量指定一款中文字体（如微软雅黑）。

**常用可选参数**：
- `--singleStep`：跳过铁牌区，铁牌区以自动滚动形式略过。
- `--fast 0.15`：控制滚榜时两次动画的间隔时间，数值越小滚得越快。
- `--display_name "{team.display_name}（{org.formal_name}）"`：自定义队伍显示格式。

如果遇到Java内存不足报错 `OutOfMemory`，可以修改 `resolver.bat` 文件，将 `-Xmx1024m` 调大，比如改成 `-Xmx4g`。

---

### 10.5 常见翻车点与解决方案

#### 🔴 问题1：`Contest not done updating`

这是最经典的滚榜翻车现场！

**现象**：Awards或Resolver一直提示 `Contest not done updating`，导致无法正常加载榜单数据。

**原因分析**：`isDoneUpdating` 的判断逻辑是检查Event Feed中有没有出现 `end_of_updates` 时间戳。如果网络慢或数据量大，ICPC Tools在默认的超时时间（10秒）内没加载完，就会报这个错。

**解决方案（按优先级排序）** ：

1. **在CDS中多次点击"End of updates"**：进入CDS Web界面，找到对应比赛，手动点击 **"End of updates"** 按钮，等几秒再点一次，通常点2-3次就能强制结束更新周期。

2. **延长ICPC Tools的超时时间**：如果方案1无效，可以修改ICPC Tools源码中的超时参数。`waitForContestLoad` 的默认超时只有2秒，总加载超时10秒。将这两处超时调大（比如改成30秒和60秒），重新编译后即可解决。

3. **终极备用方案——直接用Event Feed滚榜**：如果以上都搞不定，放弃CDS直连，直接用10.2节方式一下载的 `event-feed.json` 文件进行离线滚榜。缺点是可能无法显示队伍照片和校徽，但至少能保证滚榜顺利进行。

#### 🔴 问题2：滚榜时队伍数据不全

**现象**：Resolver中部分队伍不显示，或提交记录缺失。

**原因**：通常是CDS与DOMjudge之间的数据同步出了问题，可能是网络波动或CDS版本不匹配。

**解决**：检查CDS与ICPC Tools版本是否一致。在CDS Web界面确认比赛状态是否为 `end_of_updates`。如果仍不行，切换到离线Event Feed方式。

#### 🔴 问题3：中文显示为乱码或方框

**原因**：ICPC Tools默认不支持中文字体。

**解决**：运行Resolver时通过环境变量指定中文字体，如 `ICPC_FONT="Microsoft Yahei"`。如果系统没有微软雅黑，可以换成 `SimHei`（黑体）或 `Noto Sans SC`。

#### 🔴 问题4：滚榜卡顿或动画不流畅

**原因**：队伍数量多、图片资源大，导致Java内存不足。

**解决**：调大 `resolver.bat` 中的 `-Xmx` 参数。如果队伍照片过多，可以考虑压缩图片尺寸。

---

### ⚠️ 赛前必做：完整彩排一遍！

**强烈建议**：滚榜流程务必**赛前用真实账号、真实数据模拟一遍**！不要等到奖状都打印好了、全场观众盯着大屏幕的时候才发现滚榜工具连不上——那将是灾难性的社死现场。

彩排时至少验证：
- [ ] CDS能正常启动并连接到DOMjudge
- [ ] 能成功下载完整的event-feed文件
- [ ] Awards能正常加载数据并生成奖项配置
- [ ] Resolver能正常播放滚榜动画
- [ ] 中文能正常显示
- [ ] 队伍照片和学校Logo能正常显示（如果有的话）

---

### 📋 滚榜工作 Checklist

| 阶段     | 事项                                | 状态 |
| :------- | :---------------------------------- | :--- |
| **赛前** | 下载CDS和ICPC Tools（确保版本一致） | ☐    |
| **赛前** | 在DOMjudge创建CDS专用用户           | ☐    |
| **赛前** | 配置CDS并测试能否连接DOMjudge       | ☐    |
| **赛前** | 准备队伍照片和学校Logo（如需）      | ☐    |
| **赛前** | 完整彩排一次滚榜流程                | ☐    |
| **赛后** | 在DOMjudge中Finalize比赛            | ☐    |
| **赛后** | 在CDS中点击"End of updates"         | ☐    |
| **赛后** | 下载event-feed数据                  | ☐    |
| **赛后** | 用Awards配置奖项并保存              | ☐    |
| **赛后** | 运行Resolver开始滚榜！              | ☐    |

---

## 🐛 常见问题与踩坑指南（必看！）

### ❓ 输入ssh密码时没反应？

**正常**。Linux终端输入密码就是不回显的，大胆输完按回车。

### ❓ 安装Docker时提示 `connection timeout`

网络不好。多试几次，或者换一个镜像源（第四步中的地址）。

### ❓ 执行docker compose up 报错 `port already used`

说明12345端口被占用了。要么停掉占用的程序，要么把 Compose 文件中的 `"12345:80"` 改成 `"23456:80"`（访问时端口相应改变）。

### ❓ 启动报 `has no healthcheck configured`，或容器一直卡在 `health: starting`

**原因**：`depends_on` 里写了 `condition: service_healthy`，但被依赖的服务没定义 `healthcheck`（本文就是 mariadb）；也可能是健康检查命令在镜像里不存在，或冷启动太慢被判 `unhealthy`。注意 `docker compose up -d mariadb domserver` 这种"只起部分服务"的写法同样会检查依赖条件。

**排查顺序**：

1. 按第五步给 mariadb 补上 `healthcheck.sh --connect --innodb_initialized`，再 `docker compose config` 确认渲染结果里有 healthcheck 段。
2. 看最后一次探测的真实报错：
   ```bash
   docker inspect --format '{{json .State.Health}}' dj-mariadb
   docker inspect --format '{{json .State.Health}}' domserver
   ```
   如果输出里全是 `executable file not found`，说明镜像里没这个命令（例如 domserver 精简镜像不含 `curl`），要换成镜像自带的工具或自行构建装好 curl 的镜像；如果是权限/连接类报错，先 `docker compose pull mariadb` 更新到 10.11 的最新补丁镜像。
3. 冷启动慢就优先调大 `start_period`（本文给了 60s），而不是一味加大 `retries`。
4. 确认 `docker compose ps` 里 `dj-mariadb` 和 `domserver` 都显示 `(healthy)`，judgehost 才会被创建。

### ❓ Judgehost启动报错 `cgroup v2 not supported`

**经典踩坑**。你肯定用了Ubuntu 24.04。解决方案：

1. 简单粗暴：重装系统为Ubuntu 22.04。

2. 硬核方案（不推荐新手）：本教程已固定 `8.3.1`，这个版本也能跑 cgroup v2，但要额外配置——在 `judgehost-0` 中加 `cgroupns: host`，并按需设置 `CGROUP_MOUNT_PREFIX=/sys/fs/cgroup` 之类的环境变量；注意 Compose 里写环境变量**不带** `-e`（`-e` 是 `docker run` 的参数）。改完必须重跑第九步的压测。**别想着直接换 `latest`**，9.x 的 cgroup 要求和 8.3.1 不一样。

   如果22.04任然是cgroup v2 请看这篇文章配置:[将 Ubuntu 22.04 从 cgroup v2 切换到 cgroup v1 的完整配置教程 | Mistlane's Blog](https://blog.mistlane.top/posts/cgroup_v2_v1/)

### ❓ Judgehost启动报错 `Read-only file system`（cgroup无法创建目录）

**解决方案**：检查 `docker-compose.yml` 中 judgehost 的 cgroup 挂载配置，确保**没有** `:ro` 后缀。即：

```yaml
volumes:
  - /sys/fs/cgroup:/sys/fs/cgroup   # 正确
```
而不是：
```yaml
volumes:
  - /sys/fs/cgroup:/sys/fs/cgroup:ro   # 错误，会导致无法写入
```

### ❓ 管理员登录显示 `403 Forbidden`

你访问了选手入口 `/team` 但用了admin账号。管理员请走 `/jury`，选手请走 `/team`。

### ❓ 比赛时提交卡顿、评测慢

- 检查服务器`htop`看CPU/内存是否爆满。
- 检查带宽监控是否跑满。
- 如果judgehost只有一个，考虑临时多开几个容器分担任务（参考前面「Docker Compose 常用管理命令」一节的小提示）。

---

## 📋 你记下来的"四件套"

部署过程中，这四个东西**丢一个都寸步难行**：

| 序号 | 内容                   | 说明              |
| :--- | :--------------------- | :---------------- |
| 1️⃣    | 服务器公网IP           | `123.45.67.89`（示例） |
| 2️⃣    | 数据库root密码         | 自己设定的强密码，不要照抄本文 |
| 3️⃣    | DOMjudge数据库专用密码 | 自己设定的强密码，不要照抄本文 |
| 4️⃣    | DOMjudge管理员初始密码 | 安装日志随机生成，登录后请立即修改 |

---

## 🎊 结语：从部署到办赛

走到这里，你不仅装好了DOMjudge的网页，还配好了评测机，知道了滚榜的坑在哪——**这才是能办完一场比赛的完整技术链**。

回顾一下你完成的工作：

1. 买服务器并选了正确的Ubuntu 22.04
2. 用SSH远程连接
3. 安装Docker并配置镜像加速
4. 用Docker Compose一键部署数据库、DOMserver、Judgehost（含健康检查与固定版本）
5. 拿到管理员密码并成功访问
6. 用编译错误、超时、内存超限等异常提交做了赛前压测
7. 了解了赛后滚榜的关键注意事项

整个过程你只需要复制粘贴命令和配置文件，没有写过一行代码。

**最后送你一句肺腑之言**：赛前一定要用**真实账号、真实题目、真实网络环境**跑一遍全流程——包括异常提交和滚榜，而不是只交一发正确代码就收工。技术上最怕的不是不会，而是"以为会了"。祝你的比赛圆满成功！🎉
