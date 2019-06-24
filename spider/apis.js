const Koa = require('koa')
const MongoClient = require('mongodb').MongoClient
const cookie = require('koa-cookie')
const bodyParser = require('koa-bodyparser')
const router = require('koa-router')()
const mysql = require('promise-mysql')
const crc32 = require('buffer-crc32')

const punctuations = new RegExp(/。|，|,|！|…|!|《|》|<|>|\"|'|:|：|？|\?|、|\||“|”|‘|’|；|\\|—|_|=|（|）|·|\(|\)|　|\.|【|】|『|』|@|&|%|\^|\*|\+|\||<|>|~|`|\[|\]/, "g")
const app = new Koa()
app.proxy = true

app.use(async (ctx, next) => {
    const origin = ctx.header['origin']
    if(origin) {
        ctx.set('Access-Control-Allow-Origin', origin)
    }

    const startTime = new Date()
    await next()
    const timeDelta = new Date() - startTime
    console.log(new Date(), ctx.request.url, timeDelta)
})


function splitWords(keyword) {
    const words = []
    const segs = keyword.replace(punctuations, ' ').replace(/-/g, ' ').split(' ').filter((x) => x!='')
    segs.forEach((w) => {
        if(/^[\x00-\x7F]*$/.test(w)) {
            words.push(w)
        }else{
            for(const c of w) {
                words.push(c)
            }
        }
    })
    return words.join('|')
}

router.get('/apis/related', async (ctx) => {
    const query = ctx.query
    ctx.assert(query.keyword, 400)
    const words = splitWords(query.keyword)
    if(!words) {
        ctx.body = []
        return
    }
    const sql = 'SELECT id FROM hash WHERE MATCH(?) LIMIT 0,? OPTION max_matches=1000, max_query_time=50'

    const results = await ctx.mdb.query(sql, [words, 1*(query.count||10)])
    const ids = results.map((x) => x.id)
    const items = await ctx.torrentdb.collection('hash').find({_id: {$in: ids}}).toArray()
    for(const x of items){
        x.id = x._id
        delete x._id
    }
    ctx.body = {
        code: 0,
        items: items
    }
})


router.get('/apis/search', async (ctx) => {
    const query = ctx.query
    let sql = 'SELECT id FROM hash'
    conds = []
    values = []
    if(query.base64) {
        query.keyword = Buffer.from(query.keyword, 'base64').toString('utf8')
    }
    console.log(new Date(), 'search', query.keyword)
    if(query.keyword) {
        const kw = query.keyword.replace(punctuations, '')
        conds.push('MATCH(?)')
        values.push(kw)
    }
    if(query.category) {
        conds.push('CAT=?')
        values.push(crc32.unsigned(query.category))
    }
    if(conds.length > 0) {
        sql += ' WHERE ' + conds.join(' AND ')
    }
    if(query.sort == 'access_time' || !query.sort) {
        sql += ' ORDER BY atime DESC '
    }else if(query.sort == 'length') {
        sql += ' ORDER BY len DESC '
    }
    values.push(parseInt(query.start || 0))
    values.push(parseInt(query.count || 10))
    sql += ' LIMIT ?,? OPTION max_matches=1000, max_query_time=500'
    sql += '; SHOW META'

    const results = await ctx.mdb.query(sql, values)
    const meta = {}
    for(const v of results[1]) {
        meta[v['Variable_name']] = v['Value']
    }
    let items = results[0]
    if(query.detail) {
        const ids = items.map((x) => x.id)
        items = await fetchItems(ctx, ids)
    }
    ctx.body = {
        code: 0,
        items: items,
        meta: meta,
    }
})

async function fetchItems(ctx, ids) {
    const items = await ctx.torrentdb.collection('hash').find({_id: {$in: ids}}).toArray()
    for(const x of items){
        x.id = x._id
        delete x._id
    }
    const files = await ctx.torrentdb.collection('filelist').find({_id: {$in: items.map((x)=>x.hash)}}).toArray()
    for(const a of items) {
        for(const b of files) {
            if(a.hash == b._id) {
                a.files = b.v.filter((v) => !v.path.startsWith('__'))
            }
        }
    }
    return items
}


router.get('/apis/info', async (ctx) => {
    ctx.assert(ctx.query.ids, 400)
    const ids = ctx.query.ids.split('-').map((x) => parseInt(x))
    ctx.body = {
        items: await fetchItems(ctx, ids),
        code: 0
    }
})


app.use(router.routes())
app.use(cookie.default())
app.use(bodyParser())

async function startServer() {
    const client = await MongoClient.connect('mongodb://localhost:27017/admin', {useNewUrlParser: true})
    app.context.torrentdb = client.db('torrent')
    app.context.mdb = await mysql.createPool({
        connectionLimit: 5,
        host: 'localhost',
        user: 'root',
        password: '',
        port: 9306,
        multipleStatements: true
    })
    app.listen(process.env.PORT || 3000, async () => {
        console.log(new Date(), 'Server is istening...')
        if(process.send) {
            process.send('ready')
        }
    })
}

if(!module.parent) {
    startServer()
}
