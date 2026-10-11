# Detective Case Lab

一个用于构建、验证和游玩侦探推理案件的 TypeScript 命令行实验项目。案件以 JSON 描述人物、地点、事实、证据、证词、行动和推理条件；工具负责检查案件逻辑，并可通过 AI 生成或修复案件。

项目同时保留 V1 案件格式，并以 V2 的 **evidence-to-actor** 推理流程为主要发展方向：玩家从矛盾证词和证据出发，推导作案机制，再判断行为人及排除其他嫌疑人的依据。

## 功能

- 使用 AI 设计、生成、复核和迭代侦探案件，并保存各轮输入、输出和验证结果。
- 校验案件结构、条件引用和推理路径；可搜索可达状态并回放求解轨迹。
- 在终端中游玩通过校验的案件，或使用盲测玩家检查案件能否被推理出来。
- 支持 V1 兼容格式和 V2 格式；可从数据模型生成对应 JSON Schema。
- 通过缺陷注入和验收命令检查案例验证流程。

## 环境要求

- Node.js 22 或更高版本
- npm
- 使用模型功能时，二选一：
  - 默认方式：本机已安装并登录 Codex CLI。
  - Responses API：准备一个可用的 API Key 和支持的模型。

## 安装与本地检查

```sh
npm ci
npm run check
npm test
```

`npm run check` 执行 TypeScript 类型检查；`npm test` 运行单元测试。验证和游玩命令在本地运行，不需要模型服务；生成、修复和盲测玩家会调用模型。

## 模型配置

默认使用 Codex CLI，默认模型为 `gpt-6.1-sol`。可用环境变量调整配置：

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `DETECTIVE_PROVIDER` | 模型接入方式：`codex` 或 `responses` | `codex` |
| `DETECTIVE_MODEL` | 使用的模型名称 | `gpt-6.1-sol` |
| `DETECTIVE_TIMEOUT_MS` | 单次模型请求超时（毫秒） | `480000` |
| `DETECTIVE_CODEX_PATH` | Codex 可执行文件或内部 JavaScript 入口路径 | 自动查找 `codex` |
| `CODEX_CLI_PATH` | `DETECTIVE_CODEX_PATH` 的兼容路径变量 | — |
| `OPENAI_API_KEY` | Responses API 凭据；使用 `responses` 时必填 | — |
| `OPENAI_BASE_URL` | Responses API 服务地址 | `https://api.openai.com/v1` |
| `OPENAI_API_URL` | `OPENAI_BASE_URL` 的兼容路径变量 | — |

选择 Responses API 的示例：

```sh
export DETECTIVE_PROVIDER=responses
export OPENAI_API_KEY="你的 API Key"
export DETECTIVE_MODEL="你的模型名称"
```

PowerShell：

```powershell
$env:DETECTIVE_PROVIDER = 'responses'
$env:OPENAI_API_KEY = '你的 API Key'
$env:DETECTIVE_MODEL = '你的模型名称'
```

## 生成与验证案件

生成命令需要模型服务，并要求输出目录尚未包含已有实验记录。每次实验会写入 `manifest.json`、案件文件和按轮次保存的设计、提示词、模型响应、复核与验证结果。请为不同实验选择不同目录，避免覆盖历史。

```sh
npm run lab -- generate \
  --theme "海边旅馆发生的一起密室盗窃" \
  --constraints "所有关键线索都能通过调查获得，身份推理必须引用证据" \
  --out experiments/my-first-case \
  --repairs 2
```

通过验证后，实验根目录下的 `case.json` 是可游玩的案件。可以继续校验或开始游玩：

```sh
npm run lab -- validate experiments/my-first-case/case.json
npm run lab -- play experiments/my-first-case/case.json --save my-play.json
```

交互游玩时，程序会展示当前地点、可用行动、待追问证词和推理题。常用输入如下：

| 输入 | 作用 |
| --- | --- |
| `move <地点 ID>` | 移动到地点 |
| `act <行动 ID>` | 调查或交谈 |
| `press <证词 ID>` | 追问证词 |
| `reason <推理 ID> <选项 ID> <证据 ID,...>` | 提交不针对特定证词的推理 |
| `present <推理 ID> <证词 ID> <选项 ID> <证据 ID,...>` | 用证据回应指定证词 |
| `notebook` | 查看已获得的知识、证据和证词 |
| `quit` | 退出游玩 |

输入使用案件中显示的 ID。`present` 用于 V2 的证词回应推理；V1 案件使用其支持的推理命令。游玩前案件必须通过验证；`--save` 会保存已执行的轨迹。

## CLI 命令

所有命令通过 `npm run lab -- <命令>` 调用。文件参数使用 JSON 文件；`--out` 一般指定输出文件或目录，具体见下表。

| 命令 | 用途 |
| --- | --- |
| `schema [文件] [--version 1.0\|2.0]` | 生成 JSON Schema；默认版本为 `2.0`，默认输出到 `schema/` 下对应文件 |
| `generate --theme 文本 --out 目录 [--constraints 文本] [--repairs 数量] [--source 文件] [--injected]` | 设计并生成案件；可选提供来源案件或缺陷注入 |
| `repair <实验目录> --feedback 文件 [--repairs 数量]` | 根据 JSON 反馈继续修复已停止的 V2 实验 |
| `validate <案件文件> [--out 文件] [--limit 数量]` | 校验案件并报告问题、状态搜索和回放结果 |
| `replay <案件文件> [轨迹文件] [--out 文件]` | 回放给定轨迹；未提供轨迹时尝试使用验证得到的轨迹 |
| `play <案件文件> [--save 文件]` | 在终端交互游玩 |
| `blind <案件文件> --out 新目录 [--bind]` | 运行盲测玩家；输出目录必须是新目录。使用 `--bind` 时，输出目录需为案件目录下名称只含字母、数字、下划线或连字符的直接子目录 |
| `acceptance [实验目录] [--legacy]` | 对实验进行验收；默认目录为 `experiments/v2` |
| `report [实验目录]` | 汇总模型调用和实验修复报告；默认目录为 `experiments/v2` |
| `mutate <案件文件> --out 目录` | 生成用于验证检查器的缺陷案例 |

常用示例：

```sh
# 生成 V1 Schema 到指定文件
npm run lab -- schema ./case-v1.schema.json --version 1.0

# 保存校验报告
npm run lab -- validate experiments/my-first-case/case.json --out audit.json

# 回放并保存结果
npm run lab -- replay experiments/my-first-case/case.json my-play.json --out replay.json

# 为实验生成缺陷案例
npm run lab -- mutate experiments/my-first-case/case.json --out experiments/my-case-defects
```

`npm run verify` 和 `npm run verify:legacy` 是针对本地实验目录的便捷入口，分别读取 `experiments/v2` 和 `experiments`。验收及报告命令会在相应目录写入结果文件；在运行前确认目录内容和输出位置符合预期。

## V1 与 V2

两种格式由案件 JSON 中的 `version` 字段区分：

| 版本 | 适用范围 | 主要内容 |
| --- | --- | --- |
| `1.0` | 兼容既有原型案件 | 真相、人物、地点、证据、证词、行动、推理与结局条件 |
| `2.0` | evidence-to-actor 案件 | 在 V1 结构上增加证词追问与修订、人物情绪变化、矛盾/机制/身份推理，以及行为人归因和排除依据 |

Schema 由 `src/model.ts` 中的版本化模型生成。默认生成新案件时使用 V2；已有 V1 案件仍可通过相同的校验、回放和游玩流程处理。

## 项目结构

```text
prompts/   版本化的案件设计、生成和复核提示模板
schema/    V1 与 V2 JSON Schema
src/       案件模型、游戏引擎、生成流程、验证器和 CLI
test/      引擎、参数解析、盲测和 V2 行为测试
```

主要模块：

- `model.ts`：V1/V2 案件、状态、命令类型和 Schema。
- `engine.ts`、`public.ts`、`player-view.ts`：状态转移、玩家命令和公开信息视图。
- `validate.ts`、`validate-v2.ts`、`state-search.ts`：案件校验、版本规则和可达状态搜索。
- `generate.ts`、`generation-attempt.ts`、`review.ts`：生成、修复和复核流程。
- `provider.ts`：Codex CLI 与 Responses API 模型接入。
- `cli-args.ts`、`cli-commands.ts`：CLI 参数解析和命令处理。

## 开发命令

```sh
npm run check
npm test
```

修改案件字段时，请同步考虑对应版本的 Schema、验证逻辑、提示模板和测试。`npm run lab -- schema` 可重新导出 JSON Schema。
