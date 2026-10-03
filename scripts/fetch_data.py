"""ECOS(한국은행)·FRED(세인트루이스 연준)에서 매크로 지표를 받아 data/macro.json으로 저장한다.

- 표준 라이브러리만 사용 (GitHub Actions / 로컬 공통).
- API 키: 환경변수 ECOS_API_KEY, FRED_API_KEY. 없으면 프로젝트 루트의 .env에서 읽는다.
- 한 지표가 실패하면 기존 파일의 해당 지표를 유지하고 error 필드에 사유를 남긴다.
- 키 값은 로그·에러 메시지에 절대 출력하지 않는다.
"""
import json
import os
import pathlib
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "macro.json"
KST = timezone(timedelta(hours=9))

DAILY_YEARS = 5
LONG_YEARS = 15  # 월·분기 지표

# group: rates | inflation | growth | markets
SERIES = [
    # ── 한국 (ECOS) ──
    dict(id="kr_base_rate", country="KR", group="rates", name="한국은행 기준금리", unit="%",
         src="ECOS", code="722Y001", cycle="M", item="0101000",
         desc="한국은행 금융통화위원회가 결정하는 정책금리. 월말 기준 값."),
    dict(id="kr_ktb3", country="KR", group="rates", name="국고채 3년 금리", unit="%",
         src="ECOS", code="817Y002", cycle="D", item="010200000",
         desc="만기 3년 국고채 유통수익률(일별). 기준금리 기대를 민감하게 반영한다."),
    dict(id="kr_ktb10", country="KR", group="rates", name="국고채 10년 금리", unit="%",
         src="ECOS", code="817Y002", cycle="D", item="010210000",
         desc="만기 10년 국고채 유통수익률(일별). 장기 성장·물가 기대와 기간 프리미엄을 반영한다."),
    dict(id="kr_cpi_yoy", country="KR", group="inflation", name="소비자물가 상승률", unit="%",
         src="ECOS", code="901Y009", cycle="M", item="0", transform="yoy",
         desc="소비자물가지수(총지수, 2020=100)의 전년동월 대비 상승률. 지수에서 직접 계산."),
    dict(id="kr_gdp_qoq", country="KR", group="growth", name="실질 GDP 성장률", unit="%",
         src="ECOS", code="200Y102", cycle="Q", item="10111",
         desc="실질 국내총생산의 전기 대비 성장률(계절조정, 연율 아님)."),
    dict(id="kr_unemp", country="KR", group="growth", name="실업률", unit="%",
         src="ECOS", code="901Y027", cycle="M", item="I61BC/I28B",
         desc="경제활동인구 중 실업자 비율(계절조정, 통계청 경제활동인구조사)."),
    dict(id="kr_usdkrw", country="KR", group="markets", name="원/달러 환율", unit="원",
         src="ECOS", code="731Y001", cycle="D", item="0000001",
         desc="원/미국달러 매매기준율(일별). 값이 오르면 원화 약세."),
    dict(id="kr_kospi", country="KR", group="markets", name="KOSPI", unit="pt",
         src="ECOS", code="802Y001", cycle="D", item="0001000",
         desc="유가증권시장 종합주가지수 종가(1980.01.04=100)."),
    # ── 미국 (FRED) ──
    dict(id="us_ffr", country="US", group="rates", name="연방기금 실효금리", unit="%",
         src="FRED", code="DFF", cycle="D",
         desc="연방기금시장의 실효 금리(일별). 연준 정책금리 목표 범위 안에서 움직인다."),
    dict(id="us_2y", country="US", group="rates", name="국채 2년 금리", unit="%",
         src="FRED", code="DGS2", cycle="D",
         desc="만기 2년 미 국채 수익률(고정만기). 향후 정책금리 경로 기대를 반영한다."),
    dict(id="us_10y", country="US", group="rates", name="국채 10년 금리", unit="%",
         src="FRED", code="DGS10", cycle="D",
         desc="만기 10년 미 국채 수익률(고정만기). 글로벌 장기금리의 기준."),
    dict(id="us_10y2y", country="US", group="rates", name="장단기 금리차", unit="%p",
         src="FRED", code="T10Y2Y", cycle="D",
         desc="미 국채 10년물과 2년물 수익률 차이(10년-2년). 0 미만이면 장단기 금리 역전."),
    dict(id="us_cpi_yoy", country="US", group="inflation", name="소비자물가 상승률", unit="%",
         src="FRED", code="CPIAUCSL", cycle="M", units="pc1",
         desc="CPI(도시 소비자, 전 품목, 계절조정)의 전년동월 대비 상승률."),
    dict(id="us_core_pce_yoy", country="US", group="inflation", name="근원 PCE 물가", unit="%",
         src="FRED", code="PCEPILFE", cycle="M", units="pc1",
         desc="식품·에너지를 뺀 개인소비지출 물가지수의 전년동월 대비 상승률. 연준이 중시하는 물가 지표."),
    dict(id="us_gdp", country="US", group="growth", name="실질 GDP 성장률", unit="%",
         src="FRED", code="A191RL1Q225SBEA", cycle="Q",
         desc="실질 GDP의 전기 대비 성장률(계절조정, 연율 환산)."),
    dict(id="us_unrate", country="US", group="growth", name="실업률", unit="%",
         src="FRED", code="UNRATE", cycle="M",
         desc="미 노동통계국 실업률(계절조정)."),
    dict(id="us_payems_chg", country="US", group="growth", name="비농업 고용 증감", unit="천 명",
         src="FRED", code="PAYEMS", cycle="M", units="chg",
         desc="비농업 부문 취업자 수의 전월 대비 증감(계절조정)."),
    dict(id="us_dollar", country="US", group="markets", name="달러지수 (광의)", unit="pt",
         src="FRED", code="DTWEXBGS", cycle="D",
         desc="연준의 광의 명목 달러지수(2006.01=100). ICE 달러인덱스(DXY)와는 다른 지수."),
    dict(id="us_sp500", country="US", group="markets", name="S&P 500", unit="pt",
         src="FRED", code="SP500", cycle="D",
         desc="미국 대형주 500개 종목 지수 종가."),
    dict(id="us_wti", country="US", group="markets", name="WTI 유가", unit="$/배럴",
         src="FRED", code="DCOILWTICO", cycle="D",
         desc="서부텍사스산 원유 현물 가격(쿠싱)."),
    dict(id="us_vix", country="US", group="markets", name="VIX 변동성지수", unit="pt",
         src="FRED", code="VIXCLS", cycle="D",
         desc="S&P 500 옵션으로 산출한 향후 30일 기대 변동성. 높을수록 시장 불안."),
    dict(id="us_hy_spread", country="US", group="markets", name="하이일드 스프레드", unit="%p",
         src="FRED", code="BAMLH0A0HYM2", cycle="D",
         desc="미 투기등급 회사채와 국채의 금리차(옵션조정). 넓어질수록 신용위험 경계."),
]


def load_keys():
    keys = {k: os.environ.get(k, "").strip() for k in ("ECOS_API_KEY", "FRED_API_KEY")}
    env_file = ROOT / ".env"
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8-sig").splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                k = k.strip()
                if k in keys and not keys[k]:
                    keys[k] = v.strip().strip('"').strip("'")
    return keys


KEYS = load_keys()


def scrub(text):
    for v in KEYS.values():
        if v:
            text = text.replace(v, "***")
    return text


def get_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "macro-dashboard/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}") from None
    except urllib.error.URLError as e:
        raise RuntimeError(scrub(f"네트워크 오류: {e.reason}")) from None


def start_date(cycle, today, extra_years=0):
    years = (DAILY_YEARS if cycle == "D" else LONG_YEARS) + extra_years
    return today.replace(year=today.year - years, day=1)


def ecos_period(d, cycle):
    if cycle == "D":
        return d.strftime("%Y%m%d")
    if cycle == "M":
        return d.strftime("%Y%m")
    return f"{d.year}Q{(d.month - 1) // 3 + 1}"


def ecos_time_to_iso(t, cycle):
    if cycle == "D":
        return f"{t[:4]}-{t[4:6]}-{t[6:8]}"
    if cycle == "M":
        return f"{t[:4]}-{t[4:6]}-01"
    q = int(t[-1])
    return f"{t[:4]}-{(q - 1) * 3 + 1:02d}-01"


def fetch_ecos(s, today):
    extra = 1 if s.get("transform") == "yoy" else 0
    start = ecos_period(start_date(s["cycle"], today, extra), s["cycle"])
    end = ecos_period(today, s["cycle"])
    url = (f"https://ecos.bok.or.kr/api/StatisticSearch/{KEYS['ECOS_API_KEY']}/json/kr/1/10000/"
           f"{s['code']}/{s['cycle']}/{start}/{end}/{s['item']}")
    d = get_json(url)
    if "StatisticSearch" not in d:
        res = d.get("RESULT", {})
        raise RuntimeError(f"ECOS {res.get('CODE', '?')}: {res.get('MESSAGE', '응답 형식 오류')}")
    pts = []
    for r in d["StatisticSearch"]["row"]:
        v = (r.get("DATA_VALUE") or "").replace(",", "")
        try:
            pts.append([ecos_time_to_iso(r["TIME"], s["cycle"]), float(v)])
        except ValueError:
            continue
    pts.sort()
    if len({p[0] for p in pts}) != len(pts):
        raise RuntimeError("같은 시점에 값이 여러 개 — 항목 코드(세부 항목) 지정 필요")
    if s.get("transform") == "yoy":
        by_date = dict(pts)
        out = []
        for dt, v in pts:
            prev = f"{int(dt[:4]) - 1}{dt[4:]}"
            if prev in by_date and by_date[prev]:
                out.append([dt, round((v / by_date[prev] - 1) * 100, 2)])
        pts = out
    return pts


def fetch_fred(s, today):
    params = dict(series_id=s["code"], api_key=KEYS["FRED_API_KEY"], file_type="json",
                  observation_start=start_date(s["cycle"], today).isoformat(),
                  observation_end=today.isoformat())
    if s.get("units"):
        params["units"] = s["units"]
    d = get_json("https://api.stlouisfed.org/fred/series/observations?" + urllib.parse.urlencode(params))
    if "observations" not in d:
        raise RuntimeError(f"FRED: {d.get('error_message', '응답 형식 오류')}")
    pts = []
    for o in d["observations"]:
        try:
            v = float(o["value"])
        except ValueError:  # 결측치 "."
            continue
        pts.append([o["date"], round(v, 4)])
    return pts


def source_url(s):
    if s["src"] == "FRED":
        return f"https://fred.stlouisfed.org/series/{s['code']}"
    return "https://ecos.bok.or.kr/"


def main():
    missing = [k for k, v in KEYS.items() if not v]
    if missing:
        print(f"[오류] API 키 없음: {', '.join(missing)}", file=sys.stderr)
        return 1

    previous = {}
    if OUT.exists():
        try:
            previous = {s["id"]: s for s in json.loads(OUT.read_text(encoding="utf-8"))["series"]}
        except Exception:
            previous = {}

    now = datetime.now(KST)
    today = now.date()
    result, failures = [], 0
    for s in SERIES:
        meta = {k: s[k] for k in ("id", "country", "group", "name", "unit", "desc")}
        meta.update(freq=s["cycle"], source=s["src"], source_code=s["code"], source_url=source_url(s))
        try:
            pts = fetch_ecos(s, today) if s["src"] == "ECOS" else fetch_fred(s, today)
            if not pts:
                raise RuntimeError("데이터 없음")
            meta.update(points=pts, fetched_at=now.isoformat(timespec="seconds"))
            print(f"OK   {s['id']:<16} {len(pts):>5}개  최신 {pts[-1][0]} = {pts[-1][1]}")
        except Exception as e:
            failures += 1
            msg = scrub(str(e))
            old = previous.get(s["id"])
            meta.update(points=old["points"] if old else [],
                        fetched_at=old.get("fetched_at") if old else None,
                        error=msg)
            print(f"FAIL {s['id']:<16} {msg} (이전 데이터 {'유지' if old else '없음'})")
        result.append(meta)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {"generated_at": now.isoformat(timespec="seconds"), "series": result}
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"저장: {OUT.relative_to(ROOT)} ({OUT.stat().st_size / 1024:.0f} KB), 실패 {failures}/{len(SERIES)}")
    return 1 if failures == len(SERIES) else 0


if __name__ == "__main__":
    sys.exit(main())
