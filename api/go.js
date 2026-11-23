// api/go.js - TMAP 보행자 경로 안내 & 장소(POI) 통합 검색 Vercel 서버리스 함수

const TMAP_PEDESTRIAN_URL = 'https://apis.openapi.sk.com/tmap/routes/pedestrian?version=1&format=json';
const TMAP_POI_URL = 'https://apis.openapi.sk.com/tmap/pois';

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
}

export default async function handler(req, res) {
  setCorsHeaders(res);

  // 브라우저 CORS 사전 요청(Preflight) 처리
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: '허용되지 않은 HTTP 메서드입니다. (GET 또는 POST만 가능)' });
  }

  const appKey = process.env.TMAP_APP_KEY;
  if (!appKey) {
    return res.status(500).json({
      error: '서버 환경 변수 TMAP_APP_KEY가 설정되지 않았습니다. Vercel 설정에서 키를 등록해 주세요.'
    });
  }

  // GET 쿼리와 POST 본문 모두 지원
  const params = req.method === 'POST' ? (req.body || {}) : (req.query || {});
  const mode = String(params.mode || (params.keyword ? 'poi' : 'route')).toLowerCase();

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    // 1) 장소명(키워드) 검색 모드 (TMAP POI 통합검색 API)
    if (mode === 'poi') {
      const keyword = String(params.keyword || '').trim();
      if (!keyword) {
        clearTimeout(timeoutId);
        return res.status(400).json({ error: '검색할 장소명(keyword)을 입력해 주세요.' });
      }

      const count = Math.min(Math.max(Number(params.count) || 8, 1), 20);
      const searchParams = new URLSearchParams({
        version: '1',
        format: 'json',
        searchKeyword: keyword,
        resCoordType: 'WGS84GEO',
        reqCoordType: 'WGS84GEO',
        count: String(count)
      });

      if (params.centerLon && params.centerLat) {
        searchParams.set('centerLon', String(params.centerLon));
        searchParams.set('centerLat', String(params.centerLat));
      }

      const poiResponse = await fetch(`${TMAP_POI_URL}?${searchParams.toString()}`, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          appKey
        },
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!poiResponse.ok) {
        const errorText = await poiResponse.text();
        return res.status(poiResponse.status).json({
          error: 'TMAP 장소 검색 API 호출 실패',
          detail: errorText
        });
      }

      const poiData = await poiResponse.json();
      const rawList = poiData?.searchPoiInfo?.pois?.poi || [];
      const pois = rawList.map((item) => ({
        name: item.name || '',
        address: [item.upperAddrName, item.middleAddrName, item.lowerAddrName, item.roadName, item.buildingNo1]
          .filter(Boolean)
          .join(' '),
        lon: Number(item.frontLon || item.noorLon || 0),
        lat: Number(item.frontLat || item.noorLat || 0),
        category: item.lowerBizName || item.middleBizName || '장소'
      }));

      res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
      return res.status(200).json({ pois, raw: poiData });
    }

    // 2) 보행자 경로 안내 모드 (TMAP Pedestrian Route API)
    const startX = Number(params.startX);
    const startY = Number(params.startY);
    const endX = Number(params.endX);
    const endY = Number(params.endY);

    if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(endX) || !Number.isFinite(endY)) {
      clearTimeout(timeoutId);
      return res.status(400).json({
        error: '출발지(startX, startY)와 도착지(endX, endY) 좌표가 올바르지 않습니다.'
      });
    }

    const startName = encodeURIComponent(String(params.startName || '출발지'));
    const endName = encodeURIComponent(String(params.endName || '도착지'));

    const routeResponse = await fetch(TMAP_PEDESTRIAN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        appKey
      },
      body: JSON.stringify({
        startX,
        startY,
        endX,
        endY,
        reqCoordType: 'WGS84GEO',
        resCoordType: 'WGS84GEO',
        startName,
        endName,
        searchOption: String(params.searchOption || '0')
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!routeResponse.ok) {
      const errorText = await routeResponse.text();
      return res.status(routeResponse.status).json({
        error: 'TMAP 보행자 경로 API 호출 실패',
        detail: errorText
      });
    }

    const geoJsonData = await routeResponse.json();
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json(geoJsonData);
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err?.name === 'AbortError';
    return res.status(isTimeout ? 504 : 500).json({
      error: isTimeout ? 'TMAP API 응답 시간이 초과되었습니다.' : '서버 내부 오류가 발생했습니다.',
      detail: err?.message || String(err)
    });
  }
}
