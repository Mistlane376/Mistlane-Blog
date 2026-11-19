---
title: TCP协议与网络通讯
abbrlink: tcp-protocol-network-communication
date: 2026-11-15 23:00:00
tags:
  - 计算机网络
  - TCP
  - 知识学习
  - C/C++
categories:
  - 教程
cover: /images/selection4.jpg
description: 从三次握手、四次挥手到滑动窗口与拥塞控制，再用 socket 亲手实现一次带长度前缀的 TCP 通讯
---

## 为什么先啃 TCP

写前端的时候，一个 `fetch` 就拿到数据了，底下发生了什么完全被封装掉。但真到自己写服务端、排查「为什么接口偶发超时」「为什么大文件传到一半断了」「为什么两条消息粘成一条」，绕不开 TCP。

这篇的目标很具体：**搞懂 TCP 靠什么保证可靠，然后自己写一对能对话的服务端和客户端**。

---

**TCP 在网络分层里的位置**

| 层       | 协议例子                     | 管什么                 |
| :------- | :--------------------------- | :--------------------- |
| 应用层   | HTTP、DNS、WebSocket、SSH    | 业务语义               |
| 传输层   | **TCP**、UDP                 | 进程到进程的通信       |
| 网络层   | IP、ICMP                     | 主机到主机的寻址与路由 |
| 链路层   | 以太网、Wi-Fi                | 相邻节点之间的传输     |

TCP 在传输层，`IP + 端口` 唯一确定一个连接端点（四元组：源 IP、源端口、目的 IP、目的端口）。

**TCP 和 UDP 的区别**

| 维度     | TCP                        | UDP                      |
| :------- | :------------------------- | :----------------------- |
| 连接     | 面向连接，先握手           | 无连接，直接发           |
| 可靠性   | 确认、重传、排序、去重     | 不保证送达、不保证顺序   |
| 数据形态 | 字节流（没有消息边界）     | 数据报（保留边界）       |
| 头部开销 | 20~60 字节                 | 8 字节                   |
| 典型用途 | HTTP、数据库、文件传输     | 视频、游戏、DNS、QUIC    |

> 记住一句话：**UDP 像寄明信片，TCP 像打电话**——打电话要先接通，说错话对方会「啊？」让你重说，挂断也要两边都确认。

## TCP 的四个核心特性

1. **面向连接**：通信前三次握手，通信后四次挥手，中间维护连接状态。
2. **可靠传输**：每个字节都有序号，收到要确认，没确认就重传。
3. **字节流**：没有消息边界，应用层写几次、怎么切，到了对面可能被合并或拆开——这就是「粘包」的根源。
4. **全双工 + 流量控制**：两个方向独立传输；接收方用窗口告诉对方「我还能收多少」。

## 报文段长什么样

TCP 报文段 = 20 字节固定头（+ 最多 40 字节选项）+ 数据。

```text
 0                   1                   2                   3
 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1 2 3 4 5 6 7 8 9 0 1
+-------------------------------+-------------------------------+
|          源端口 (16)          |         目的端口 (16)         |
+-------------------------------+-------------------------------+
|                         序号 seq (32)                         |
+---------------------------------------------------------------+
|                        确认号 ack (32)                        |
+-------+-----------+-----------+-------------------------------+
| 首部长 | 保留 |U|A|P|R|S|F| 窗口大小 (16)                     |
|   (4) |  (6) |R|C|S|S|Y|I|                                    |
|       |      |G|K|H|T|N|N|                                    |
+-------------------------------+-------------------------------+
|        校验和 (16)            |        紧急指针 (16)          |
+-------------------------------+-------------------------------+
|                    选项（可变，0~40 字节）                     |
+---------------------------------------------------------------+
|                          数据                                  |
+---------------------------------------------------------------+
```

**关键字段**

| 字段         | 作用                                                     |
| :----------- | :------------------------------------------------------- |
| 序号 `seq`   | 本报文段第一个字节在字节流中的位置                       |
| 确认号 `ack` | 期望收到的下一个字节的序号（表示之前的都收到了）         |
| `SYN`        | 建立连接，同时消耗一个序号                               |
| `ACK`        | 确认号有效                                               |
| `FIN`        | 发送方没有数据了，请求关闭                               |
| `RST`        | 重置连接（端口没开、连接异常时出现）                     |
| `PSH`        | 提示接收方尽快把数据交给应用层                           |
| 窗口 `rwnd`  | 接收窗口大小，用于流量控制                               |

> 序号是 **32 位无符号数**，到 `2^32-1` 会回绕。所以比较序号大小不能直接比数值，要看「环形距离」，这是实现 TCP 时最容易写错的地方之一。

## 建立连接：三次握手

```text
   客户端                                        服务端
   CLOSED                                        LISTEN
     |                                              |
     |  1. SYN  seq=x                                |
     | -------------------------------------------> |
     |  SYN_SENT                                   SYN_RCVD
     |                                              |
     |  2. SYN + ACK  seq=y, ack=x+1                 |
     | <------------------------------------------- |
     |                                              |
     |  3. ACK  ack=y+1                              |
     | -------------------------------------------> |
   ESTABLISHED                                 ESTABLISHED
```

**每一步在干什么**

1. 客户端发 `SYN`，带上自己的初始序号 `x`——「我想连你，我的序号从 x 开始」。
2. 服务端回 `SYN + ACK`，自己的初始序号 `y`，`ack = x+1`——「收到了，我同意，我的序号从 y 开始」。
3. 客户端回 `ACK, ack = y+1`——「收到你的序号了」。这一步就可以捎带数据（比如 HTTP 请求）。

**为什么是三次，不是两次**

- **两次确认不了客户端的接收能力**。前两次只能证明「客户端能发、服务端能收能发」，客户端能不能收，得靠第三次让服务端知道。
- **防止历史连接的旧 SYN**。如果客户端一个很早以前的 SYN 迟到了，服务端两次就建连，会白白开一个连接等数据，而客户端根本不知道。三次握手让客户端有机会用 `RST` 拒绝掉这种旧请求。
- **同步双方初始序号**，各自确认对方的 ISN，保证序号空间对齐。

**两个队列**

服务端 `listen` 之后有两个队列：

- **SYN 队列**（半连接）：收到 SYN、回了 SYN+ACK、还没等到 ACK 的连接。
- **accept 队列**（全连接）：三次握手完成、等待应用 `accept()` 取走的连接。

队列满了会丢包或拒绝，表现为客户端连接超时。`backlog` 主要限制后者，Linux 实际取 `min(backlog, net.core.somaxconn)`。

> SYN Flood 攻击就是拼命发 SYN 不回 ACK，把半连接队列塞满。常见的缓解手段是 SYN Cookie：不保存状态，把信息编码进 `seq` 里。

## 断开连接：四次挥手

```text
   客户端                                        服务端
  ESTABLISHED                                ESTABLISHED
     |                                              |
     |  1. FIN  seq=u                               |
     | -------------------------------------------> |
   FIN_WAIT_1                                  CLOSE_WAIT
     |                                              |
     |  2. ACK  ack=u+1                             |
     | <------------------------------------------- |
   FIN_WAIT_2          （此时服务端还能继续发数据）    |
     |                                              |
     |  3. FIN  seq=w                               |
     | <------------------------------------------- |
     |                                          LAST_ACK
     |  4. ACK  ack=w+1                             |
     | -------------------------------------------> |
   TIME_WAIT                                     CLOSED
     | 等 2MSL（Linux 60s）
   CLOSED
```

**为什么要四次**

TCP 是全双工的，两个方向要各自关闭：

- 客户端发 `FIN` 只表示「我不发了」，还能继续收。
- 服务端收到后先回 `ACK`（我还可能有事没说完），等自己的数据发完，再单独发 `FIN`。

所以 `ACK` 和 `FIN` 通常不能合并，就变成了四次。如果服务端恰好也没数据了，第 2、3 步可能合并成一次，看起来像三次。

**`TIME_WAIT` 为什么必须等 2MSL**

1. **保证最后一个 ACK 能到**。如果 ACK 丢了，对方会重传 `FIN`，此时自己还在 `TIME_WAIT` 才能再补一个 ACK；提前关掉就会回 `RST`，对方异常终止。
2. **让旧连接的残留报文在网络里消散**，避免四元组复用后，新连接收到上一条连接的陈旧数据。

> 常见误区：`CLOSE_WAIT` 堆积不是内核的问题，是**应用没调 `close()`**——收到 FIN 只回了 ACK，代码里忘了关 fd。真实项目里这个状态涨到几千，基本就是连接泄漏。

## 可靠传输是怎么做到的

「可靠」不是一句口号，是四个机制叠出来的。

**1. 序号 + 确认 + 重传**

每个字节都有序号，接收方回 `ACK` 表示「这个序号之前的我都收到了」（累计确认）。发送方超时没收到确认就重传。

超时时间 `RTO` 不是拍脑袋：用 RTT 的平滑值和抖动来估算（Jacobson/Karn 算法），Linux 里最小 200ms，初始 1s。

**2. 快速重传**

不用傻等超时。如果发送方连续收到 **3 个重复 ACK**（同一个 `ack` 值），说明中间那段丢了，立刻重传，不等 RTO 到期。

**3. 滑动窗口与流量控制**

发送方不是发一个等一个，而是可以连续发一整个窗口。窗口由接收方通告的 `rwnd` 决定——「我缓冲区还有这么大，别再发了」。窗口降到 0 时发送方停止，并定期发探测包，防止死锁。

**4. 拥塞控制**

`rwnd` 管的是接收方能力，`cwnd`（拥塞窗口）管的是**网络**能力，两者都是猜的，实际发送窗口取较小值：

```text
发送窗口 = min(cwnd, rwnd)
```

`cwnd` 的演化分四个阶段：

| 阶段     | 行为                                     | 触发条件                     |
| :------- | :--------------------------------------- | :--------------------------- |
| 慢启动   | `cwnd` 每个 RTT 翻倍（指数增长）         | 连接开始 / 超时重传后        |
| 拥塞避免 | 每个 RTT 加 1 个 MSS（线性增长）         | `cwnd` 达到 `ssthresh`       |
| 快重传   | 收到 3 个重复 ACK 立即重传丢失段         | 3 个重复 ACK                 |
| 快恢复   | `ssthresh = cwnd/2`，`cwnd` 不必回到 1   | 快重传之后                   |

超时重传的惩罚最重：`ssthresh = cwnd/2`，`cwnd = 1`，重新慢启动。

> 补充两个现代特性：**SACK** 让接收方告诉发送方「我收到的区间」，避免一次丢包把后面全重传；**Nagle 算法**会把小包攒起来发，配合延迟 ACK 可能出现 40ms 的莫名延迟，交互型服务通常关掉它（`TCP_NODELAY`）。

## 字节流没有边界：粘包与拆包

这是新手写 TCP 最容易翻车的地方。

```text
发送方 write("hello")  write("world")
                                ↓ TCP 只管字节流
接收方 read() 可能拿到 "helloworld"      ← 粘包
接收方 read() 可能只拿到 "hel"           ← 拆包
```

**不是 TCP 的 bug**：它承诺的是「字节按顺序到达」，从没承诺「你写几次我读几次」。消息边界必须由**应用层协议**自己划。

**三种划边界的方式**

| 方案     | 做法                       | 优点             | 缺点                       |
| :------- | :------------------------- | :--------------- | :------------------------- |
| 固定长度 | 每条消息定长，不够补齐     | 实现最简单       | 浪费带宽，长度不灵活       |
| 分隔符   | 用 `\n` 或 `\0` 分隔       | 可读性好，好调试 | 内容里出现分隔符要转义     |
| 长度前缀 | 先发 4 字节长度，再发内容  | 高效、无歧义     | 需要约定字节序（约定大端） |

实际工程里几乎都用**长度前缀**，HTTP/2 的帧、Redis 的 RESP、gRPC 的 message 都是这个思路。

```text
+--------+--------------------------+
| 4 字节 |        N 字节            |
| 长度 N |        消息体            |
+--------+--------------------------+
```

## 动手实现：C++ 版本

用 Linux 的 POSIX socket（macOS 基本一致；Windows 要换 Winsock，多一步 `WSAStartup`）。

**服务端 `server.cpp`**

```cpp
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>

// 精确读 n 字节：处理短读和 EINTR
bool read_n(int fd, char* buf, size_t n) {
  size_t got = 0;
  while (got < n) {
    ssize_t r = recv(fd, buf + got, n - got, 0);
    if (r == 0) return false;            // 对端关闭
    if (r < 0) {
      if (errno == EINTR) continue;
      return false;
    }
    got += static_cast<size_t>(r);
  }
  return true;
}

// 精确写 n 字节：send 可能只写进去一部分
bool write_n(int fd, const char* buf, size_t n) {
  size_t sent = 0;
  while (sent < n) {
    ssize_t r = send(fd, buf + sent, n - sent, MSG_NOSIGNAL);
    if (r <= 0) {
      if (r < 0 && errno == EINTR) continue;
      return false;
    }
    sent += static_cast<size_t>(r);
  }
  return true;
}

int main() {
  int listen_fd = socket(AF_INET, SOCK_STREAM, 0);
  if (listen_fd < 0) { perror("socket"); return 1; }

  // 重启服务时端口可能还在 TIME_WAIT，允许复用
  int yes = 1;
  setsockopt(listen_fd, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof yes);

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_addr.s_addr = htonl(INADDR_ANY);   // 监听所有网卡
  addr.sin_port = htons(9000);                // 主机序 -> 网络序

  if (bind(listen_fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) {
    perror("bind");
    return 1;
  }
  if (listen(listen_fd, 128) < 0) { perror("listen"); return 1; }

  std::cout << "listening on :9000\n";

  for (;;) {
    sockaddr_in peer{};
    socklen_t len = sizeof peer;
    int fd = accept(listen_fd, reinterpret_cast<sockaddr*>(&peer), &len);
    if (fd < 0) {
      if (errno == EINTR) continue;
      perror("accept");
      break;
    }

    char ip[INET_ADDRSTRLEN] = {0};
    inet_ntop(AF_INET, &peer.sin_addr, ip, sizeof ip);
    std::cout << "connected: " << ip << ":" << ntohs(peer.sin_port) << "\n";

    uint32_t net_len = 0;
    while (read_n(fd, reinterpret_cast<char*>(&net_len), 4)) {
      uint32_t n = ntohl(net_len);            // 网络序 -> 主机序
      if (n == 0 || n > (1u << 20)) break;    // 防御：单条不超过 1MB

      std::string msg(n, '\0');
      if (!read_n(fd, msg.data(), n)) break;
      std::cout << "recv: " << msg << "\n";

      std::string reply = "echo: " + msg;
      uint32_t out = htonl(static_cast<uint32_t>(reply.size()));
      if (!write_n(fd, reinterpret_cast<char*>(&out), 4)) break;
      if (!write_n(fd, reply.data(), reply.size())) break;
    }

    close(fd);
    std::cout << "disconnected\n";
  }

  close(listen_fd);
  return 0;
}
```

**客户端 `client.cpp`**

```cpp
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <cerrno>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>

// read_n / write_n 同上，实际项目抽到 net.h

int main(int argc, char** argv) {
  std::string text = argc > 1 ? argv[1] : "hello tcp";

  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { perror("socket"); return 1; }

  sockaddr_in addr{};
  addr.sin_family = AF_INET;
  addr.sin_port = htons(9000);
  if (inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr) != 1) {
    std::cerr << "bad address\n";
    return 1;
  }

  if (connect(fd, reinterpret_cast<sockaddr*>(&addr), sizeof addr) < 0) {
    perror("connect");
    return 1;
  }

  uint32_t out = htonl(static_cast<uint32_t>(text.size()));
  write_n(fd, reinterpret_cast<char*>(&out), 4);
  write_n(fd, text.data(), text.size());

  uint32_t net_len = 0;
  if (!read_n(fd, reinterpret_cast<char*>(&net_len), 4)) return 1;
  std::string reply(ntohl(net_len), '\0');
  if (!read_n(fd, reply.data(), reply.size())) return 1;

  std::cout << "server: " << reply << "\n";
  close(fd);
  return 0;
}
```

**编译运行**

```bash
g++ -std=c++17 -O2 -Wall -o server server.cpp
g++ -std=c++17 -O2 -Wall -o client client.cpp

./server                 # 终端 1
./client "你好 TCP"       # 终端 2
./client "第二条消息"      # 反过来再发一条，验证连接是长连接
```

预期输出：

```text
# 服务端
listening on :9000
connected: 127.0.0.1:52344
recv: 你好 TCP
recv: 第二条消息
disconnected
```

> 注意服务端是「一个连接一个循环」的串行模型。真实服务要并发：`fork` / 线程池 / `epoll` 多路复用。这一层就是后面 Node 的 event loop、Nginx 的 reactor 模型在做的事。

## 同一件事用 Python 和 Node 写

**Python（最短能跑的版本）**

```python
import socket
import struct

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("0.0.0.0", 9000))
srv.listen(128)
print("listening on :9000")

while True:
    conn, peer = srv.accept()
    with conn:
        print("connected:", peer)
        while True:
            head = conn.recv(4)
            if len(head) < 4:
                break                      # 对端关闭或半包
            (n,) = struct.unpack("!I", head)  # ! 表示网络字节序（大端）
            buf = b""
            while len(buf) < n:            # recv 同样要循环读满
                chunk = conn.recv(n - len(buf))
                if not chunk:
                    break
                buf += chunk
            print("recv:", buf.decode())
            body = ("echo: " + buf.decode()).encode()
            conn.sendall(struct.pack("!I", len(body)) + body)  # sendall 负责写满
```

**Node.js（全栈路线上迟早要写）**

```js
const net = require('node:net')

function frame(text) {
  const body = Buffer.from(text)
  const head = Buffer.alloc(4)
  head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

net.createServer((socket) => {
  let buf = Buffer.alloc(0)

  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0)
      if (buf.length < 4 + len) break          // 还没收全，等下一次 data
      const msg = buf.subarray(4, 4 + len).toString()
      buf = buf.subarray(4 + len)              // 消费掉这条
      socket.write(frame('echo: ' + msg))
    }
  })

  socket.on('error', () => {})
}).listen(9000, () => console.log('listening on :9000'))
```

> Node 的 `net` 已经帮你处理了「循环读满」，但**边界照样要自己划**——`data` 事件给的是任意长度的分片。

## 工具箱：验证与排障

理论只能解释现象，工具才能定住证据。这一节把排查 TCP 问题真正会用到的命令收在一起，顺序是「先粗后细」：先用 `nc` 造一个对端，再看内核状态，最后抓包看字节。

### 1. nc：手搓一个 TCP 对端

```bash
# 起一个最简陋的服务端，收到什么原样打印
nc -l 9000                # 部分老版本要写 nc -l -p 9000

# 另开终端当客户端，输入后回车发送
nc 127.0.0.1 9000

# 只探测端口通不通（-z 不发数据，-v 打印结果，-w 设超时）
nc -zv -w 2 127.0.0.1 9000
```

用处比想象中大：

- 服务端还没写好，先让 `nc -l` 冒充服务端，验证客户端逻辑对不对。
- 反过来让 `nc` 当客户端，手打字节测试服务端解析，专治粘包。
- 抓包时最干净：`nc` 没有任何应用层协议，看到的全是裸 TCP。

> Windows 上的等价物是 PowerShell 的 `Test-NetConnection 127.0.0.1 -Port 9000`（只能探测），或者装 nmap 时带的 `ncat`。

### 2. ss：看连接，也看内核眼里的连接

```bash
ss -tlnp                              # 谁在监听：-t TCP / -l listen / -n 数字 / -p 进程
ss -tan state established             # 只看已建立的连接
ss -tan state time-wait | wc -l       # TIME_WAIT 到底堆了多少
ss -s                                 # 各状态汇总
ss -ti dst 127.0.0.1                  # 最重要的一条
```

`ss -ti` 会把内核维护的 `tcp_info` 抖出来，性能问题基本靠它定位：

```text
ESTAB 0 0 127.0.0.1:9000 127.0.0.1:52344
  cubic wscale:7,7 rto:204 rtt:0.06/0.02 ato:40 mss:65483
  cwnd:10 bytes_acked:1 bytes_received:1 segs_out:8 segs_in:9
  send 8.7Mbps lastsnd:1200 lastrcv:1200 lastack:1200
  retrans:0/1 reordering:3
```

| 字段    | 含义                   | 异常时的信号                     |
| :------ | :--------------------- | :------------------------------- |
| `rtt`   | 往返时延 / 抖动        | 抖动大说明链路拥塞或 Wi-Fi 不稳   |
| `cwnd`  | 拥塞窗口               | 一直很小说明在丢包，拥塞控制在压  |
| `retrans` | 重传次数 / 总发送段数 | 持续增长就是真丢包               |
| `rto`   | 重传超时时间           | 飙高说明 RTT 估计失效            |
| `wscale` | 窗口缩放因子          | 与对端不匹配会直接限制吞吐        |

> `netstat` 在多数发行版已经被弃用（它读 `/proc` 全表，上万连接时会卡死），`ss` 走 netlink，快得多。

### 3. lsof / netstat：端口被谁占了

```bash
lsof -i :9000                    # Linux / macOS
lsof -i tcp:9000 -sTCP:LISTEN    # 只找监听者
```

Windows：

```powershell
netstat -ano | findstr :9000     # 最后一列是 PID
tasklist | findstr <PID>
```

典型场景：`bind: Address already in use` 十有八九不是别人占了端口，而是自己的旧进程还在 `TIME_WAIT`。先用 `lsof` 确认，再决定是加 `SO_REUSEADDR` 还是换端口。

### 4. tcpdump：命令行抓包

```bash
sudo tcpdump -i any -nn -S 'tcp port 9000'
```

参数逐个说清：

| 参数 | 作用 |
| :--- | :--- |
| `-i any` | 所有网卡（本机回环建议直接 `-i lo`） |
| `-nn` | 不做 DNS 和端口名解析，输出更快更准 |
| `-S` | 显示绝对序号，方便自己算 `ack` |
| `-c 20` | 抓 20 个包就停 |
| `-tttt` | 带完整日期时间 |
| `-A` / `-X` | 按 ASCII / 十六进制 + ASCII 打印载荷 |
| `-w cap.pcap` | 存文件，**抓包一定要先存文件** |

过滤器速查：

| 想抓什么           | 表达式                                                          |
| :----------------- | :-------------------------------------------------------------- |
| 某个端口           | `tcp port 9000`                                                 |
| 某台主机           | `host 10.0.0.5`                                                 |
| 单向会话           | `src host 10.0.0.5 and dst port 9000`                           |
| 只看握手           | `'tcp[tcpflags] & tcp-syn != 0 and tcp[tcpflags] & tcp-ack == 0'` |
| 只看 RST           | `'tcp[tcpflags] & tcp-rst != 0'`                                |
| 排除 SSH 噪音      | `'tcp port 9000 and not port 22'`                                |

输出里的标志位：

```text
Flags [S]      SYN
Flags [S.]     SYN + ACK
Flags [.]      纯 ACK
Flags [P.]     PSH + ACK，带数据
Flags [F.]     FIN + ACK
Flags [R]      RST，连接被重置（最常见的是端口没开）
```

`-S` 能直接看到序号递增：

```text
IP 127.0.0.1.52344 > 127.0.0.1.9000: Flags [S], seq 1001
IP 127.0.0.1.9000 > 127.0.0.1.52344: Flags [S.], seq 5001, ack 1002
IP 127.0.0.1.52344 > 127.0.0.1.9000: Flags [.], ack 5002
```

> `length 0` 的纯 ACK 是 TCP 自己在维护可靠性，不是应用发的数据。别看到「怎么多了一个包」就慌。

### 5. Wireshark / tshark：把字节流还原成消息

命令行就够用了：

```bash
tshark -r cap.pcap -Y 'tcp.analysis.retransmission'              # 只看重传
tshark -r cap.pcap -Y 'tcp.flags.syn==1 && tcp.flags.ack==0'     # 只看第一次握手
tshark -r cap.pcap -q -z follow,tcp,ascii,0                      # 跟随第 0 条流看应用层
```

图形界面的常用过滤：

| 表达式                                        | 作用                             |
| :-------------------------------------------- | :------------------------------- |
| `tcp.port == 9000`                            | 按端口                           |
| `tcp.stream eq 0`                             | 只看某一条连接                   |
| `tcp.flags.syn == 1 && tcp.flags.ack == 0`    | 客户端发起的握手                 |
| `tcp.analysis.retransmission`                 | 重传                             |
| `tcp.analysis.zero_window`                    | 接收窗口被撑爆，对端处理不过来   |
| `tcp.len > 0`                                 | 带载荷的包                       |

两个特别值钱的功能：

1. **Follow → TCP Stream**：把双向字节流拼出来。粘包问题在这里一眼看穿——你能看到应用层的两条消息真的被塞进了同一个 segment。
2. **Statistics → TCP Stream Graphs → Time/Sequence**：横轴时间、纵轴序号，斜率就是吞吐。出现平台期代表停等重传，阶梯状代表窗口受限，整体平移代表 RTT 大。

> 坑：`tcpdump -i any` 在 loopback 上会抓两遍（收发各一次），看起来像重复包，Wireshark 会给出 `TCP ACKed unseen segment` 之类的假象。抓本机回环用 `-i lo`，别用 `any`。

### 6. curl：把一次 HTTP 请求拆成 TCP 时间线

TCP 之上最常跑的就是 HTTP，`curl` 是最省事的分层观察器。

```bash
curl -v http://127.0.0.1:9000/            # 请求头、响应头，以及 * Connected to ...
curl --http1.1 -v https://example.com     # 强制 1.1，对比 HTTP/2 的连接复用
```

真正好用是 `-w`，把每个阶段耗时打出来：

```bash
curl -o /dev/null -s -w '
dns:   %{time_namelookup}s
tcp:   %{time_connect}s
tls:   %{time_appconnect}s
first: %{time_starttransfer}s
total: %{time_total}s
ip:    %{remote_ip}
' https://example.com
```

这段输出直接对应分层：

- `time_namelookup` 大 → DNS 慢，跟 TCP 没关系；
- `time_connect - time_namelookup` 大 → **TCP 握手慢**（RTT 高、SYN 被丢、backlog 满）；
- `time_appconnect - time_connect` 大 → TLS 握手慢；
- `time_starttransfer - time_appconnect` 大 → 服务端处理慢，或请求体上传慢。

这就是「接口慢到底慢在哪一层」最快的答案，比翻日志靠谱得多。

### 7. iperf3：量一下真实带宽

```bash
iperf3 -s                            # 服务端
iperf3 -c 127.0.0.1 -t 5 -P 4        # 4 条并发流跑 5 秒
iperf3 -c 127.0.0.1 -t 5 -R          # 反向：服务端发、客户端收
```

单条 TCP 流吃不满带宽是常态——受 `cwnd`、RTT 和窗口缩放限制。带宽延迟积 `BDP = 带宽 × RTT` 就是「在途数据量」的上限，窗口小于它，吞吐必然上不去。所以要看多流总和，而不是一条流的结果。

### 8. ping / mtr：链路问题别让 TCP 背锅

```bash
ping -c 4 10.0.0.5
mtr -n -c 20 10.0.0.5     # 每一跳的丢包与延迟，比 traceroute 直观
```

两个容易误判的地方：

1. **ICMP 被限速不代表 TCP 有问题**。很多网络对 ICMP 降级处理，`ping` 丢包但 HTTP 正常很常见。
2. **`ping` 通也不代表端口通**。中间防火墙可能只放行特定端口。

### 9. strace：进程到底卡在哪

```bash
strace -f -tt -e trace=network ./server
```

能一路看到 `socket → bind → listen → accept` 的返回值和耗时：

- 卡在 `accept` → 没人连，或者 backlog 满了；
- 卡在 `recv` → 在等数据，阻塞模型下是正常的；
- `send` 返回 `EPIPE` → 对端已经关了，再写就会收到 `SIGPIPE`。

排查「程序卡死」比自己读代码快得多。

### 10. sysctl：先看参数，别急着调

```bash
sysctl net.core.somaxconn                 # accept 队列上限
sysctl net.ipv4.tcp_max_syn_backlog       # 半连接队列上限
sysctl net.ipv4.tcp_tw_reuse              # 允许复用 TIME_WAIT（仅出向连接）
sysctl net.ipv4.tcp_congestion_control    # cubic / bbr
sysctl net.ipv4.tcp_rmem net.ipv4.tcp_wmem  # 读写缓冲三元组（min / default / max）
```

原则是**先量再调**。另外 `tcp_tw_recycle` 在 4.12 之后已经移除（NAT 环境下会误杀连接），网上大批老教程还在教，别照抄。

### 11. 按症状选工具

| 症状                          | 先看什么                          | 常见原因                                   |
| :---------------------------- | :-------------------------------- | :----------------------------------------- |
| `Connection refused`          | `ss -tlnp`                        | 服务没起，或只监听在 `127.0.0.1`           |
| `connect` 卡住后 timeout      | `tcpdump` 看 SYN 有没有回         | 防火墙 DROP、backlog 满、路由不通          |
| 连上后一发数据就断            | `ss -ti` 看 `retrans`、`dmesg`    | MTU 黑洞、中间设备重置                     |
| 偶发慢，重试就好              | `curl -w` 拆阶段、`ss -ti`        | 丢包触发重传、Nagle + 延迟 ACK             |
| 吞吐上不去                    | `iperf3 -P 4`、`ss -ti` 看 `cwnd` | 窗口太小、BDP 限制、单流受限               |
| `TIME_WAIT` 成千上万          | `ss -tan state time-wait` 计数    | 短连接太频繁，该上连接池 / keep-alive      |
| `CLOSE_WAIT` 越积越多         | `lsof -p <pid>` 数 fd             | 代码忘了 `close()`，是 bug 不是内核问题    |

### 12. 用这套工具回看前面的代码

把 `./server` 跑起来，另开一个终端：

```bash
ss -tlnp | grep 9000                          # 1. 确认在监听
sudo tcpdump -i lo -nn -S 'tcp port 9000' -w cap.pcap &
./client "你好 TCP"                            # 2. 发一条消息
# Ctrl+C 停掉 tcpdump，然后用 Wireshark 打开 cap.pcap：
#   前三包是握手，中间是 [P.] 带着长度前缀的数据，最后是四次挥手
tshark -r cap.pcap -q -z follow,tcp,ascii,0    # 3. 直接看应用层发了什么
```

做完这一步，前面讲的「粘包」和「长度前缀」就不再是抽象概念——你能在抓包里亲眼看到那 4 个字节的长度，和紧跟其后的消息体。

**Windows 下的工具对照**

| 用途       | Linux / macOS     | Windows                              |
| :--------- | :---------------- | :----------------------------------- |
| 抓包       | `tcpdump`         | Wireshark、`pktmon`                  |
| 连接状态   | `ss`              | `netstat -ano`、`Get-NetTCPConnection` |
| 端口占用   | `lsof -i :9000`   | `netstat -ano` + `tasklist`          |
| 端口探测   | `nc -zv`          | `Test-NetConnection`                 |
| 手工收发   | `nc`              | `ncat`（nmap 附带的版本）            |

## 踩过的坑

1. **`recv` 返回 0 就以为出错**：返回 0 表示**对端有序关闭**，这是正常结束，必须跳出循环并 `close`，否则 fd 泄漏成 `CLOSE_WAIT`。
2. **只调一次 `send` / `write`**：大消息会被截断，返回的是「实际写进去多少」，必须循环。
3. **字节序没转**：端口和长度前缀走网络时必须 `htons` / `htonl`，本机小端直接发出去，对端解析成长度几亿。
4. **忘了 `SO_REUSEADDR`**：重启服务报 `Address already in use`，因为上个进程的端口还在 `TIME_WAIT`。
5. **`SIGPIPE` 杀进程**：往已关闭的连接写数据，默认收到 SIGPIPE 直接退出。用 `MSG_NOSIGNAL`（Linux）或忽略信号。
6. **粘包**：不做长度前缀，消息一多就串行错位。
7. **`listen` 的 backlog 写太小**：高并发下 `accept` 队列溢出，内核直接丢 SYN，客户端看到的是「连接超时」而不是「连接被拒」——很难查。
8. **不设 `TCP_NODELAY`**：请求-响应式的小包被 Nagle + 延迟 ACK 卡 40ms，压测时 p99 难看。
9. **以为 `read` 一次就是一条消息**：这条其实和第 6 条是同一件事，但值得单独记一遍，因为它真的会让人怀疑人生。

## 再往上走

TCP 只是地基，上面的东西都长在它身上：

| 协议        | 和 TCP 的关系                                            |
| :---------- | :------------------------------------------------------- |
| HTTP/1.1    | 一个 TCP 连接串行处理请求，队头阻塞                      |
| HTTP/2      | 一个 TCP 连接上多路复用，但丢包仍会阻塞所有流（TCP 层队头） |
| WebSocket   | 先 HTTP 握手升级，之后在同一个 TCP 上双向发帧            |
| HTTP/3      | 直接换成 **QUIC（基于 UDP）**，就是为了绕开 TCP 的队头阻塞 |

再往下就是服务端工程的题：`epoll` 如何做到万级并发、连接池怎么复用连接、心跳包为什么必须存在（NAT 会悄悄断掉空闲连接）。

> 学习建议：先把这篇的代码跑通、用 `tcpdump` 亲眼看一遍三次握手，再去读 `epoll` 和 reactor 模型。跳过「亲手收发字节」这一步直接上框架，遇到连接问题会完全无从下手。
