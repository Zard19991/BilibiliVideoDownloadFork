import { message } from 'ant-design-vue'
import lodash from 'lodash'
import { ascendingSort } from './utils/sort'
import { decodeDanmakuSegment, decodeDanmakuView } from './danmaku-segment'
import { DanmakuConverterConfig, DanmakuConverter } from './danmaku-converter'
import { XmlDanmaku } from './xml-danmaku'
import { store, pinia } from '../../store'
import { randUserAgent, getWbiKeys, encWbi } from '../../utils'

function getGotConfig () {
  return {
    headers: {
      'User-Agent': randUserAgent(),
      cookie: `SESSDATA=${store.settingStore(pinia).SESSDATA}`
    }
  }
}

interface GotConfig {
  headers: {
    'User-Agent': string,
    cookie: string
  }
}

export class JsonDanmaku {
  // static SegmentSize = 6 * 60
  public jsonDanmakus: {
    id: number
    idStr: string
    progress: number
    mode: number
    fontsize: number
    color: number
    midHash: string
    content: string
    ctime: number
    weight: number
    action: string
    pool: number
    attr: number
  }[] = []

  constructor (
    public cid: number | string
  ) { }

  // get segmentCount() {
  //   return Math.ceil(this.duration / JsonDanmaku.SegmentSize)
  // }
  get xmlDanmakus () {
    return this.jsonDanmakus.map(json => ({
      content: json.content,
      time: json.progress ? (json.progress / 1000).toString() : '0',
      type: json.mode?.toString() ?? '1',
      fontSize: json.fontsize?.toString() ?? '25',
      color: json.color?.toString() ?? '16777215',
      timeStamp: json.ctime?.toString() ?? '0',
      pool: json.pool?.toString() ?? '0',
      userHash: json.midHash ?? '0',
      rowId: json.idStr ?? '0'
    }))
  }

  async fetchInfo () {
    let viewBuffer: any
    try {
      viewBuffer = await window.electron.gotBuffer(`https://api.bilibili.com/x/v2/dm/web/view?type=1&oid=${this.cid}`, getGotConfig())
    } catch (error) {
      throw new Error('获取弹幕信息失败')
    }
    if (!viewBuffer) {
      throw new Error('获取弹幕信息失败')
    }
    const view = await decodeDanmakuView(viewBuffer)
    const { total } = view.dmSge
    if (total === undefined) {
      throw new Error(`获取弹幕分页数失败: ${JSON.stringify(lodash.omit(view, 'flag'))}`)
    }
    const SESSDATA = store.settingStore(pinia).SESSDATA
    let img_key = ''
    let sub_key = ''
    if (!SESSDATA) {
      const web_keys = await getWbiKeys('')
      img_key = web_keys.img_key
      sub_key = web_keys.sub_key
    }

    const segments = await Promise.all(new Array(total).fill(0).map(async (_, index) => {
      let buffer: any
      try {
        const params = {
          type: 1,
          oid: this.cid,
          segment_index: index + 1
        }
        let query = Object.keys(params).map(key => `${key}=${params[key]}`).join('&')
        if (!SESSDATA) {
          query = encWbi(params, img_key, sub_key)
        }
        const danmaAPI = `https://api.bilibili.com/x/v2/dm/web/seg.so?${query}`
        // console.log('danmaAPI', danmaAPI)

        buffer = await window.electron.gotBuffer(danmaAPI, getGotConfig())
      } catch (error) {
        throw new Error('获取弹幕信息失败')
      }
      if (!buffer) {
        console.error(new Error(`弹幕片段${index + 1}下载失败`))
        return []
      }
      const resStr = new TextDecoder().decode(buffer)
      // 正常返回的是 弹幕的字符串 无法json parse
      // 如果返回-352则 风控校验失败 (UA 或 wbi 参数不合法)
      if (resStr.includes('-352')) {
        console.error('接口返回:', JSON.parse(resStr))
        throw new Error(`弹幕片段${index + 1}下载失败: 获取弹幕信息失败 code -352`)
      }
      const result = await decodeDanmakuSegment(buffer)
      // console.log(result)
      return result.elems ?? []
    }))
    this.jsonDanmakus = segments.flat().sort(ascendingSort(it => it.progress))
    return this
  }
}

export const getUserDanmakuConfig = async (title: string) => {
  // 标题需作为参数传入
  const defaultConfig: Omit<DanmakuConverterConfig, 'title'> = {
    font: '微软雅黑',
    alpha: 0.4,
    duration: (danmaku: { type: number }) => {
      switch (danmaku.type) {
        case 4:
        case 5:
          return 4
        default:
          return 6
      }
    },
    blockTypes: [7, 8],
    resolution: {
      x: 1920,
      y: 1080
    },
    bottomMarginPercent: 0.15,
    bold: false
  }
  const config = { ...defaultConfig, title } as DanmakuConverterConfig
  for (const [key, value] of Object.entries(config)) {
    if (value === undefined || value === null) {
      console.warn('danmaku config invalid for key', key, ', value =', value)
      config[key] = defaultConfig[value]
    }
  }
  return config
}

export const convertToAssFromJson = async (danmaku: JsonDanmaku, title: string) => {
  const converter = new DanmakuConverter(await getUserDanmakuConfig(title))
  const assDocument = converter.xmlDanmakuToAssDocument(
    danmaku.xmlDanmakus.map(x => new XmlDanmaku(x))
  )
  return assDocument.generateAss()
}

export const downloadDanmaku = async (cid: number, title: string, path: string) => {
  try {
    const danmaku = await new JsonDanmaku(cid).fetchInfo()
    const str = await convertToAssFromJson(danmaku, title)
    window.electron.saveDanmukuFile(str, path)
  } catch (error: any) {
    console.error('error', error)
    // webpack://bilibilivideodownload-fork/./node_modules/protobufjs/src/reader.js?e5c5
    // index out of range:
    // TODO: error index out of range: 3 + 99 > 39
    message.error(`弹幕下载错误：${error.message}`)
  }
}
