import json,re,urllib.request,concurrent.futures as cf,os
d=json.load(open("all.json"))
cache=json.load(open("posts.json")) if os.path.exists("posts.json") else {}
def get(x):
    m=re.search(r"status(?:es)?/(\d+)",x.get("demo_url") or "")
    if not m: return x["id"],{"err":"no status id"}
    try:
        r=json.load(urllib.request.urlopen(urllib.request.Request(f"https://api.fxtwitter.com/status/{m.group(1)}",headers={"User-Agent":"dedupe/1.0"}),timeout=20))
        t=r.get("tweet") or {}
        txt=t.get("text","")
        art=t.get("article") or {}
        if art: txt+="\n[ARTICLE] "+json.dumps(art)[:4000]
        urls=[f.get("replacement") for f in ((t.get("raw_text") or {}).get("facets") or []) if f.get("type")=="url"]
        return x["id"],{"text":txt,"urls":urls}
    except Exception as e: return x["id"],{"err":str(e)}
todo=[x for x in d if x["id"] not in cache or "err" in cache[x["id"]]]
with cf.ThreadPoolExecutor(8) as ex:
    for i,(k,v) in enumerate(ex.map(get,todo)): cache[k]=v
json.dump(cache,open("posts.json","w"),indent=1)
print("fetched",len(todo),"errors",sum(1 for v in cache.values() if "err" in v))
