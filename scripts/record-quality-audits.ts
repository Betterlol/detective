import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { hash, readJson, saveJson } from '../src/io.js';

// These are direct observations from reading the actual public replay, not automated verdicts.
const observations = [
  {
    name: 'theatre-1', expectedHash: '081239a7c15c476d3584fd2b535a180d568440b1bbfb23f60b075a309b762d7e',
    premises: '第2/3步取得谢幕受检铃与演前照片，第4步有限目击先于第7步矛盾；第9步回收旧铃先于第11步机制；第13步连续取换与腰袋保管才支持第15步身份。',
    identity: '林澈先核对月牙缺口，再连续看见周岚取旧铃、从蓝袋放入另一只，立即收入自己穿着的腰袋，谢幕摇响后当场交检。旧铃在共用袋找回提供物件对应。',
    alternatives: '共用袋、道具职责、修铃请求和唐姐岗位均未被当作排他证明；照片与受检铃的差异排除只是摇法不同，连续手部取放与保管排除更晚换铃。',
    revealAndPress: '第6步追问引出取布说法；第7步只否定全程留室，不声称有意隐瞒。改口开放共用袋调查；第13步新增连续动作和同一物件保管，使最后归属有新增依据。',
    proseAndLeakage: '周岚立即否认、程叔说明袋内看不见、赵叔提醒不可据岗位定责，角色语气有差异。开场仅有闷声疑点；机制保留两次核对之间的宽时间范围，未提前指定中场动作或实施者。',
    remaining: ['证物来源、可靠性和限制与知识提示有重复，阅读仍略显解释性。', '后两题正确项较长，第一题已打破固定最长答案模式；该长度检查不能证明没有语义提示。'],
  },
  {
    name: 'theatre-2', expectedHash: 'f39bc9578300617be9aae40909987672fa2c84d47f0cc60952d435e1bbcf9aa9',
    premises: '第4步提示单、第6步许茜近看旧铃早于第8步矛盾；第9步检查木纹、空腔、轻晃早于第10步机制；第12步漆流连续追踪与第15步旧铃回收早于第17步身份。',
    identity: '许茜看到林棠取下带蓝线补绳、缺口的旧铃；阿哲看到林棠挂入白漆流铃，并持续追踪到谢幕取用、归还和玩家检查。两人分别覆盖取下和挂入，检查确认为木制仿铃。',
    alternatives: '共用钥匙和开放门只说明机会，不证明周逸换铃；木纹与无铃舌排除铜铃卡舌。连续漆流物件链排除演出后另换一只，针线盒发现只补充去向。',
    revealAndPress: '第6步追问实际取得林棠持旧铃的近距离观察；矛盾后开放现铃检查。机制先限定为当前结构能产生闷响，身份阶段才取得同一铃贯穿谢幕和检查的连续性。',
    proseAndLeakage: '林棠清单式答话、周逸报cue、许茜的现场反应相互区别；第10步明确还不知道受检铃是否为谢幕用铃，没有使用第12步未来材料。',
    remaining: ['机械结论是有限的结构解释，完整换铃机制要与后续身份链合看。', '证物说明略长，阿哲长时间守候观察仍带微型案件的集中安排感。'],
  },
  {
    name: 'radio-1', expectedHash: '521ea6f9c4dc3d6b53c1552776f3dadb1d825ec71a27dabced8d68090c29d63d',
    premises: '第2/5步原卡与完整播出句先于第7步差异；第9步现场流程和第10步阿成的选段试听先于第11步局部删除；第12步接缝持续到导出、队列和线路启动先于第13步完整归属。',
    identity: '阿成听清被删的是“没有”并看见邱岚删除；罗姨从删除前开始跟踪未关闭、未切换的同一时间线接缝到导出，再看到同路径新文件入队。梅姐只启动线路，手机录音核对公开结果。',
    alternatives: '输出录音与原卡明确不同；连续选段试听、删除和即时句义变化处理噪声、缩放与别段工程解释。文件名和动机不承担版本或实施证明，梅姐启动线路与邱岚剪辑/选入明确区分。',
    revealAndPress: '矛盾使邱岚改口承认处理副本并把播控推给梅姐；第8步追问取得导出与排播不是一回事的流程。后续两段调查分别补足删除与实际送播，身份题仍有实际新增材料。',
    proseAndLeakage: '原句和播出句后半句“是维修组按检修表，周三先关的”现已一致；描述均标为历史目击，没有说玩家正在看当年删除。开场不指定剪辑者，完整身份在最后确立。',
    remaining: ['路径、接缝连续性描述较技术化，限制说明有重复。', '机制节点已经获得删除者目击；身份节点的新增任务是证明送播而不是再次猜名字。'],
  },
  {
    name: 'radio-2', expectedHash: '8fe65386f305fb2761037814aa77bf19ecbed7c22511b1ee4be92f9582117b9b',
    premises: '第1/2步两份声音、第5步离场反证先于第7步矛盾；第8步追问后第9步当面核对删前/后工程先于第10步机制；第11步卡片连续性、第12步预置键目击先于第13步身份。',
    identity: '徐姨听的是室内外放，亲见罗岚选段删除、导出、同一卡直接入槽，并一直看着卡槽到18:30播完。吴师傅独立看到罗岚预置18:30键；操作卡解释定时播放当前单曲卡。',
    alternatives: '工程删前句子与相邻底噪核对原声，具体删除位置解释缺词；文件名不识别人。同一卡无换卡观察及单曲操作说明处理导出仅为备份、值班员另选版本；开放权限和施工压力不能替代动作。',
    revealAndPress: '初问只问罗岚在哪，不声称徐姨没看后续；矛盾引出备份说法，追问提供工程所在位置。机制后才分别取得删除、卡片保管和节目键观察，后续调查改变结论支持强度。',
    proseAndLeakage: '徐姨与吴师傅口语答话自然；初始目击到后续完整观察没有自相矛盾。18:22–25按键与18:30响声通过预置说明相连，避免时刻跳跃。首题选项只用此前原声与在场材料。',
    remaining: ['徐姨持续等待二十余分钟略显安排集中；身份判断依赖她的明确现场观察范围。', '设备流程和限制解释较长，仍可继续压缩文字。'],
  },
  {
    name: 'greenhouse-1', expectedHash: '7ad4a8f4847f130800c23d9da300c9b703f0e35687b66a67b22334af16f798aa',
    premises: '第2步交班表和第7步追问先于第8步矛盾；第9步取得当前开位、流水、完整管路端点，第10步复测先于第11步可行机制；第12步两处持续观察先于第13步历史实施归属。',
    identity: '周师傅认脸看秦岚把黄柄由关转开，林澄另见秦岚将管端放入编号槽并开始流水；两处守到漫水未见其他人改动。连续追管将两个动作接成同一水路。',
    alternatives: '交班表不记阀位，人影不能指认，高芸改口不定罪；无自动部件、完整支路及槽水线处理自动补水和别床漏水。18:39到19:05约26分钟符合复测20–30分钟范围。',
    revealAndPress: '第7步具体追问揭示高芸仅看床面，带来第8步改口与实际水路调查；机制只解释当前可行供水，后续目击才确认事故前设置和实际操作人。',
    proseAndLeakage: '开场19:05明确来自林澄值班本且是发现时间；早期林澄18:34看不清，不与后来18:39移到床端的清楚观察冲突。机制没有提前引用尚未取得的18:39–19:05观察。',
    remaining: ['在场两人长时间观察而未干预具有叙事便利感，但观察时段、对象和局限具体。', '两处见证与水路说明偏密集；人物口气有差异，说明文字仍可再简练。'],
  },
  {
    name: 'greenhouse-2', expectedHash: '426e623c720da9df6b269138d0633cd04eec14bbc0d50afe4011def5d8dde497',
    premises: '第2步完整→折断目击和第6步追问先于第7步标签矛盾；第8步取片停水、卡回复水及托盘测量先于第9步能力机制；第11步断面比对、第13/14步两名动作目击先于第15步归属。',
    identity: '林澄与乔叔分别直接见邵岚压下指定阀杆并塞入短片，认脸/呼名应答识人；乔叔同时见同一出口开始出水。回收片与T-17断面相合，唯一水路和复现补足因果。',
    alternatives: '短片来源和人在阀旁均不单独定责；直接压杆、塞片及停水/复水复现处理仅放标签和阀自身故障，单一支路/干燥接头处理漏水。没有把12分钟观察间隔乘事故后流量冒充实际水量。',
    revealAndPress: '追问锁定断裂先后说法，矛盾后改口称已丢短片，开放阀缝复查。机制后才开放准备间断面比对与独立动作目击，身份推理具有新材料。',
    proseAndLeakage: '机制结论及其知识提示现均删除未来18:26/18:38目击；来源匹配留到第11步。首题错误选项已改成与明确折断目击冲突的解释，全部题目不再稳定用唯一最长项提示答案。',
    remaining: ['目击者称在3–5米辨认T-17字样，未交代字大小；编号可读性的描写还可更可信。身份和物件对应同时有应答、动作与事后断面核对支持，不单靠远读编号。', '因果证明不精确重建事故供水时长和水量，结案现明确保留该限制。', '解释文字比人物对白更密集。'],
  },
];

const root = resolve(process.argv[2] ?? 'experiments/agent-tools-20261011');
for (const o of observations) {
  const dir = join(root, o.name), c = await readJson(join(dir, 'case.json'));
  const manifest = await readJson(join(dir, 'manifest.json')) as { status: string; acceptedCaseHash: string };
  const verification = await readJson(join(dir, 'verification.json')) as { ok: boolean };
  if (manifest.status !== 'accepted' || hash(c) !== o.expectedHash || manifest.acceptedCaseHash !== o.expectedHash || !verification.ok)
    throw new Error(`${o.name}: 待审文件已变化或程序未通过，不得复用人工观察`);
  const record = { version: 'manual-player-quality-1.0', reviewedAt: new Date().toISOString(), verdict: 'pass-with-minor',
    method: '根 Agent 直接逐步阅读玩家可见回放、当时可选项及推理输出；没有调用 caseReview 或 blindPlaytest。程序检查与此判断分别记录。',
    caseHash: hash(c), replayHash: hash(await readJson(join(dir, 'replay.json'))),
    exportHash: hash(await readFile(join(dir, 'player-replay.md'), 'utf8')), initialQualityPassed: false, ...o };
  await saveJson(join(dir, 'quality-audit.json'), record);
  await saveJson(join(dir, 'quality-audit-' + o.expectedHash + '.json'), record);
}
console.log('6 个逐案质量判断已绑定最终文件和玩家回放。');
