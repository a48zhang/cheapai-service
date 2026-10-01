# 第三方来源与许可声明

核对日期：2026-09-05。P21 建立来源和未来移植要求；P21-L 另附完整 LGPL v3 / GPL v3 许可文本。这两项任务未向本工程复制 Sub2API 业务源码或测试 fixture，也未对整个工程授予或更改许可证。其他任务引入的第三方材料须逐项补充此文件。

## Sub2API 协议参考

- 项目：[Wei-Shaw/sub2api](https://github.com/Wei-Shaw/sub2api/tree/ab99d56e9626e6cd731592dae8553c9758a0efa2)。
- 固定 commit：`ab99d56e9626e6cd731592dae8553c9758a0efa2`。
- 范围：`backend/internal/pkg/apicompat/` 的源码、测试和三个 `testdata/issue5302` JSON 样例，作为后续协议适配参考。精确文件、blob 和用例关系见 [协议基线](docs/protocol-baseline.md)。
- 实际许可：[固定提交根 LICENSE](https://github.com/Wei-Shaw/sub2api/blob/ab99d56e9626e6cd731592dae8553c9758a0efa2/LICENSE) 为 GNU Lesser General Public License，Version 3，29 June 2007；blob `153d416dc8d2d60076698ec3cbfce34d91436a03`。不是 MIT，也不是 AGPL。
- 根 LICENSE 引入 GNU GPL version 3 的条款并附 LGPL 额外许可。当前仅核对到 LGPL v3 文本，不凭通用许可证第 6 节自行断言上游授权“or later”。
- 完整递归目录树未截断；按 LICENSE/NOTICE/COPYING 文件名检查，只找到根 LICENSE，没有独立 NOTICE/COPYING 或模块专用许可文件。所下载 apicompat Go 文件未发现单独版权/SPDX 声明。未发现 NOTICE 不意味着可以删除将来获得的第三方声明。
- LICENSE 中 Free Software Foundation, Inc. 的 2007 版权行是许可证文本的版权声明，不能据此将其列作 Sub2API 源码作者或编造源码版权年份。

## 未来复制、翻译和发布时的适用要求

以下按上述上游实际许可文本制定移植记录要求，不宣称本任务已经完成这些发布条件。

1. 逐文件记录原项目、固定 commit、原路径/blob、对应测试、具体修改及日期，保留收到的版权、许可和免责声明。Go 改写为 TypeScript 或翻译测试不能自动视作没有衍生关系；协议思想的独立实现与直接改编代码须如实区分。
2. 如果分发受许可代码或改编库，须按适用条款提供相应许可、修改说明及源代码；LGPL 覆盖的部分不能仅改标为本工程许可证。源码和测试/fixture 都纳入来源登记，不仅处理运行时代码。
3. 若按 LGPL 第 4 节分发 Combined Work，须提供显著的库使用/许可声明，并附 GNU GPL v3 和 LGPL v3 完整文本；不得限制库部分的修改或为调试修改而进行的逆向工程。依条款采用可替换的共享库机制，或提供适于重组合/重链接的 Minimal Corresponding Source 和 Corresponding Application Code；需要时提供 Installation Information。
4. Worker 打包成一个产物不应直接假定满足共享库替换条件。真正引入代码时须结合构建/分发方式落实上述条件，发布清单中保留对应源码、构建与重组说明。网络部署的事实本身也不能用来推断某一次分发已经合规。
5. P21-L 已附下述完整 LGPL v3 与 GPL v3 文本。附入文本不等于文件级来源、修改声明、显著使用声明或适用的对应源码/构建重组材料已齐备；这些材料仍须随实际移植和每次发布维护并验收。
6. 后续新模块、前端、依赖或其他来源的 fixture 需独立核对许可；本记录没有审计 Sub2API 全部第三方依赖，也不授权复制凭据、旧生产数据或整个项目。

## 已附许可文本与原文核对（P21-L）

取证日期：2026-09-05。官方 GNU 文本通过 Python `urllib.request.urlopen` 使用默认 HTTPS 证书验证读取；保存响应原始字节，不改写正文。临时证据位于工程外 `../../work/p21-protocol-reference/`。此前其他读取途径失败不计作来源证据。

| 本地材料 | 实际取得来源与一致性 | 字节数 | SHA-256 |
| --- | --- | --- | --- |
| [LICENSES/LGPL-3.0.txt](LICENSES/LGPL-3.0.txt) | 原样复制已核对的固定 Sub2API 根 LICENSE；Git blob 保持 `153d416dc8d2d60076698ec3cbfce34d91436a03` | 7651 | `a5681bf9b05db14d86776930017c647ad9e6e56ff6bbcfdf21e5848288dfaf1b` |
| [LICENSES/GPL-3.0.txt](LICENSES/GPL-3.0.txt) | [GNU 官方 GPL v3 原文](https://www.gnu.org/licenses/gpl-3.0.txt)；与下载字节完全一致 | 35149 | `3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986` |

另取得 [GNU 官方 LGPL v3 原文](https://www.gnu.org/licenses/lgpl-3.0.txt)，7652 字节，SHA-256 `e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118`。它与固定 Sub2API LICENSE 的唯一字节差异是末尾多一个 LF；完整正文相同。本地 LGPL 保留固定上游原样，不为消除该差异重排文字。

两份正文标题均为 Version 3, 29 June 2007。LGPL 包含第 0–6 节及最终 Library 句；GPL 包含序言、第 0–17 节、END OF TERMS AND CONDITIONS 和 How to Apply These Terms to Your New Programs 附录，不是节选。GPL 中提及 AGPL 的兼容条款不改变本文件是 GPL v3 的事实。

这两份文件提供将来受覆盖材料需要随附的许可文本，**不自动把整个工程设为 GPL 或 LGPL，也不表明移植、发布条件或运行验证已经完成**。具体文件的许可范围仍由实际来源和改动决定；逐文件来源、修改日期、测试派生记录以及适用的对应源码、构建和重组说明仍须维护。

## 本次验证边界

仅从固定 GitHub 来源下载 LICENSE 和 48 个 apicompat 文件到工程外工作证据目录，49 个 Git blob 校验全部一致；未运行上游测试、未执行协议移植、未部署、未调用真实模型。P21-L 又核对官方完整许可文本及两个落盘副本，未新增业务代码。本声明与协议基线的静态检查结果不能作为运行兼容性或发布合规验收完成的证明；没有云、邮件或模型调用验收。
