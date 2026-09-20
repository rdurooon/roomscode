"""Rate limiting em janela deslizante para eventos Socket.IO.

O Flask-Limiter (ver app.py) só cobre as rotas HTTP comuns. Eventos de
Socket.IO não passam por essas rotas, então cada evento que precisa de
limite usa uma instância de `SlidingWindowRateLimiter` própria, chaveada
pelo que fizer mais sentido para aquele evento (sid do socket, IP do
visitante, etc.) — a mesma classe é reaproveitada em vez de reimplementar a
lógica de janela deslizante em cada módulo de evento.
"""

import time
from collections import defaultdict, deque


class SlidingWindowRateLimiter:
    def __init__(self):
        self._hits: dict = defaultdict(deque)

    def is_limited(self, key, count: int, window_seconds: int) -> bool:
        """Registra uma tentativa para `key` e retorna True se o limite de
        `count` tentativas em `window_seconds` segundos já foi excedido."""
        now = time.time()
        timestamps = self._hits[key]
        while timestamps and now - timestamps[0] > window_seconds:
            timestamps.popleft()

        if len(timestamps) >= count:
            return True

        timestamps.append(now)
        return False
