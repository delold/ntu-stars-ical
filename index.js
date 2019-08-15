import moment from 'https://dev.jspm.io/moment'
import cheerio from 'https://dev.jspm.io/cheerio'
import ical from 'https://dev.jspm.io/ical-generator'

const startOfSemester = moment('12-08-2019', 'DD-MM-YYYY')
const recessWeek = moment('30-09-2019', 'DD-MM-YYYY')

const weekRegex = /(?:wk|,)((?<range>[0-9]+-[0-9]+)|(?<single>[0-9]+))/i
const parseBlocks = (html) => {
  const mergeBlocks = (blocks) => {
    const timeMap = {}
    const newBlocks = []
    for (const block of blocks) {
      const key = `${block.day} ${block.end}`
      if (!timeMap[key]) timeMap[key] = {}
      timeMap[key][block.raw] = block
    }
  
    for (const block of blocks) {
      const key = `${block.day} ${block.begin}`
      if (timeMap[key] && timeMap[key][block.raw]) {
        timeMap[key][block.raw].end = block.end
      } else {
        newBlocks.push(block)
      }
    }
  
    return newBlocks
  }

  const $ = cheerio.load(html)
  $('html').find('br').replaceWith('\n')

  const [, time,] = $("table").toArray()

  const days = $("tr:first-child td:nth-child(n+2)", time).toArray().map(i => $(i).text().trim())
  let daysOffset = Array(days.length).fill(0)
  const blocks = []

  const rows = $("tr", time).toArray().slice(1)

  // parse rows
  for (const row of rows) {
    let newDaysOffset = daysOffset.map((item) => Math.max(0, item - 1))
    // subject block has a rowspan set
    for (const subject of $("td[rowspan]", row).toArray()) {
      const realIndex = $(subject).index() - 1
      const targetIndex = realIndex + daysOffset.reduce((memo, acc, index) => memo + (acc > 0 && index <= realIndex), 0)

      const rowspan = Number.parseInt($(subject).attr("rowspan"), 10)
      const lastrow = [$(row), ...$(row).nextAll().toArray()][rowspan - 1]

      const day = days[targetIndex]
      const begin = $("td:first-child", row).text().split('-').shift().trim()
      const end = $("td:first-child", lastrow).text().split('-').pop().trim()

      const options = $(subject).text().trim().split('\n').filter(item => Boolean(item.trim()));
      
      // split names to separate sections, b/c remarks are merged with block info
      const preparsed = options.reduce((memo, item) => {
        if (!memo.length) {
          memo.push([item])
        } else {
          const prevItem = memo[memo.length - 1]
          if (weekRegex.test(item)) {
            prevItem.push(item)
          } else {
            memo.push([item])
          }
        }

        return memo
      }, [])

      for (const [main, rest] of preparsed) {
        const [course, type, group, room, ...namerest] = main.trim().split(" ")
        const detail = [rest, ...namerest].filter(Boolean).join('\n')
        
        // parse week ranges
        const block = { day, begin, end, course, type, group, room, detail, raw: [main, rest].join(' ') }
        blocks.push(block)
      }

      newDaysOffset[targetIndex] = Math.max(0, rowspan - 1)
    }

    daysOffset = newDaysOffset
  }

  return mergeBlocks(blocks)
}

const generateSchedule = (cal, blocks) => {
  const weekRegexGlobal = new RegExp(weekRegex, 'ig')
  const getAllowedWeeks = (rules) => {
    const res = Array(13).fill(null).map((_, i) => i + 1)
    if (!rules || !rules.length) return res
    return res.filter(item => {
      return rules.some(rule => {
        if (rule.includes('-')) {
          const [from, to] = rule.trim().split('-').map(i => Number.parseInt(i.trim(), 10))
          return item >= from && item <= to
        }
  
        return rule === `${item}`
      })
    })
  }

  for (const block of blocks) {
    const { detail, day, begin, end } = block
    const bounds = [...detail.matchAll(weekRegexGlobal)].map(i => i.groups.range || i.groups.single)
    getAllowedWeeks(bounds).forEach(week => {
      const parsed = startOfSemester.clone()
        .add(week - 1, 'week')
        .set('day', day)

      if (parsed.isSameOrAfter(recessWeek)) {
        parsed.add(1, 'week')
      }

      const [startDate, endDate] = [begin, end].map(i => parsed.clone().set({
        hour: Number.parseInt(i.substr(0, 2), 10),
        minute: Number.parseInt(i.substr(2, 2), 10),
      }))
      
      cal.createEvent({
        start: startDate,
        end: endDate,
        summary: (block.name && `${block.course}: ${block.name} ${block.type} ${block.group}`) || `${block.course} ${block.type} ${block.group}`,
        location: block.room,
        description: [
          block.group && `Group: ${block.group}`,
          block.room &&`Location: ${block.room}`,
          block.detail && `Detail: ${block.detail}`
        ].filter(Boolean).join('\n'),
      })
    })
  }
}

const parseExams = (html) => {
  const $ = cheerio.load(html)
  $('html').find('br').replaceWith('\n')

  const [,, exams,] = $("table").toArray()

  return $("tr:not(:first-child):not(:last-child)", exams).toArray().map(row => {
    const code = $("td:nth-child(2)", row).text().trim()
    const date = $("td:nth-child(5)", row).text().trim()


    return { code, date }
  })
}

const generateExams = (cal, exams) => {
  const timeRegex = /(?<rawBegin>[0-9]{4})-(?<rawEnd>[0-9]{4})/
  for (const { code, date } of exams) {
    const [rawDate, rawTime] = date.split(' ', 2)
    const parsedDate = moment(rawDate, 'DD-MMM-YYYY')

    const parsedTime = rawTime.match(timeRegex)
    if (!parsedTime || !parsedDate.isValid()) continue

    const { rawBegin, rawEnd } = parsedTime.groups
    const [begin, end] = [rawBegin, rawEnd].map(i => ({
      hours: Number.parseInt(i.substr(0, 2).trim(), 10),
      minutes: Number.parseInt(i.substr(2, 2).trim(), 10),
    }))

    const payload = {
      start: parsedDate.clone().set(begin),
      end: parsedDate.clone().set(end),
      summary: code,
    }

    cal.createEvent(payload)
  }
}

export const generate = (html) => {
  const cal = ical()
  cal.prodId('//duong.cz//ntu-ical//EN')

  generateSchedule(cal, parseBlocks(html))
  generateExams(cal, parseExams(html))

  return cal
}

