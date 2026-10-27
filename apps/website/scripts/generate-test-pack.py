from pathlib import Path
import io,json,zipfile,hashlib,struct,zlib,wave,math
base=Path(__file__).resolve().parents[1]
out=base/'public/downloads';out.mkdir(parents=True,exist_ok=True)
def archive(items):
    b=io.BytesIO()
    with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
        for name,data in sorted(items.items()):
            info=zipfile.ZipInfo(name,(2026,10,26,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;z.writestr(info,data)
    return b.getvalue()
def chunk(k,v):return struct.pack('!I',len(v))+k+v+struct.pack('!I',zlib.crc32(k+v)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',64,64,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(b'\0'+bytes([70+y,130,190])*64 for y in range(64))))+chunk(b'IEND',b'')
w=io.BytesIO()
with wave.open(w,'wb') as f:
    f.setnchannels(1);f.setsampwidth(2);f.setframerate(8000);f.writeframes(b''.join(struct.pack('<h',int(1500*math.sin(2*math.pi*220*i/8000))) for i in range(2400)))
report='합성 물리 실험 기록\n실제 학생·연구 자료가 아닙니다.\n시간(s),거리(m)\n0,0\n1,0.2\n'.encode()
files={'물리_실험.txt':report,'물리_실험_복사본.txt':report,'여행_사진.png':png,'여행_기록.md':'# 합성 여행 메모\n개인정보가 없는 테스트 파일입니다.\n'.encode(),'측정_데이터.csv':b'time_s,distance_m\n0,0\n1,0.2\n2,0.4\n','녹음_샘플.wav':w.getvalue(),'참고_자료.zip':archive({'참고.txt':'압축 형식 확인용 합성 문서입니다.\n'.encode()})}
rules={'formatVersion':1,'name':'AFO 체험용 분류 규칙','rules':[{'id':'physics-text','extension':'.txt','keyword':'물리','targetDirectory':'학교/물리','enabled':True},{'id':'images','extension':'.png','keyword':None,'targetDirectory':'이미지','enabled':True},{'id':'audio','extension':'.wav','keyword':None,'targetDirectory':'소리','enabled':True},{'id':'data','extension':'.csv','keyword':'측정','targetDirectory':'학교/데이터','enabled':True}]}
manifest=[{'name':n,'bytes':len(d),'sha256':hashlib.sha256(d).hexdigest()} for n,d in sorted(files.items())]
readme='''# AFO 테스트 파일\n\n모든 자료는 프로그램이 만든 합성 파일이며 개인정보·실제 과제·실행 프로그램이 없습니다.\n\n1. ZIP을 새 테스트 폴더에 압축 해제합니다.\n2. 웹의 나의 규칙 → JSON으로 가져오기·내보내기 → 예시_규칙.json을 가져옵니다.\n3. 브라우저에 저장하고 새로고침합니다. 로그인한 경우 클라우드 불러오기 후 저장도 확인할 수 있습니다.\n4. 웹의 내 폴더 분석에서 정리할파일 폴더를 직접 선택해 읽기 전용 미리보기와 중복 후보를 확인합니다. 중복 검사는 사용자가 시작할 때만 파일 내용을 기기에서 읽습니다. 파일은 이동하거나 삭제하지 않습니다.\n\n물리_실험.txt와 복사본은 내용이 같습니다. 중복 후보 검증용이며 자동 삭제를 뜻하지 않습니다.\n웹 규칙 JSON은 CLI의 로컬 프로필/실행 승인과 다른 형식입니다.\n'''
payload={'AFO_테스트파일/정리할파일/'+n:d for n,d in files.items()}
payload.update({'AFO_테스트파일/예시_규칙.json':(json.dumps(rules,ensure_ascii=False,indent=2)+'\n').encode(),'AFO_테스트파일/사용방법.md':readme.encode(),'AFO_테스트파일/manifest.json':(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n').encode()})
data=archive(payload);(out/'AFO-test-files.zip').write_bytes(data)
(out/'AFO-example-rules.json').write_text(json.dumps(rules,ensure_ascii=False,indent=2)+'\n')
meta={'fileName':'AFO-test-files.zip','sampleFileCount':len(files),'archiveFileCount':len(payload),'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'files':manifest,'date':'2026-10-26'}
(base/'src/data/test-pack.json').write_text(json.dumps(meta,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in meta.items() if k!='files'},ensure_ascii=False))
