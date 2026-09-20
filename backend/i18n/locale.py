"""Resolução e carregamento de idioma (i18n) do RoomsCode.

Camadas de detecção do idioma do visitante, da mais confiável pra mais
fraca:

1. Cookie de preferência manual (``Config.LOCALE_COOKIE_NAME``) — se o
   visitante já escolheu um idioma antes (seletor manual, ou uma detecção
   anterior já persistida), esse valor sempre vence.
2. Cabeçalho ``Accept-Language`` do navegador — reflete a preferência real
   configurada pelo usuário no SO/navegador, então tem prioridade sobre
   qualquer inferência por localização (idioma e país não são a mesma
   coisa).
3. ``CF-IPCountry`` — cabeçalho injetado de graça pelo Cloudflare Tunnel
   (já usado como proxy reverso do projeto, ver ``backend/net.py``) com o
   país do visitante. Usado só quando o Accept-Language está ausente ou não
   bate com nenhum idioma suportado.
4. ``Config.DEFAULT_LOCALE`` — se nada dos anteriores resolver.

O carregamento das traduções é feito uma única vez por processo (os
arquivos JSON não mudam em runtime) e fica em cache em memória. Qualquer
chave ausente num idioma que não seja o fonte cai automaticamente para
``Config.DEFAULT_LOCALE``, pra nunca deixar um buraco em branco na tela por
causa de uma tradução esquecida.
"""

import json
import os

from flask import request

from ..config import Config

_TRANSLATIONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "translations")

# Mapa de país (CF-IPCountry, formato ISO 3166-1 alpha-2) para idioma
# suportado. Não precisa ser exaustivo: é só o fallback usado quando o
# Accept-Language não ajuda, então cobrir os países mais prováveis já
# resolve a maioria dos casos reais. Países não listados caem para
# Config.DEFAULT_LOCALE.
_COUNTRY_TO_LOCALE = {
    # Português
    "BR": "pt-BR",
    "PT": "pt-BR",
    # Espanhol
    "ES": "es",
    "MX": "es",
    "AR": "es",
    "CO": "es",
    "CL": "es",
    "PE": "es",
    "VE": "es",
    "EC": "es",
    "GT": "es",
    "CU": "es",
    "BO": "es",
    "DO": "es",
    "HN": "es",
    "PY": "es",
    "SV": "es",
    "NI": "es",
    "CR": "es",
    "PA": "es",
    "UY": "es",
    # Inglês
    "US": "en",
    "GB": "en",
    "CA": "en",
    "AU": "en",
    "NZ": "en",
    "IE": "en",
    "ZA": "en",
    "IN": "en",
}

_translations_cache = {}

# Metadata de exibição do seletor de idioma (bandeira + nome do idioma no
# próprio idioma — convenção padrão de seletores de idioma, não é uma
# "tradução" de verdade, então fica fora dos arquivos translations/*.json).
# flag_file aponta pro nome do partial SVG em
# frontend/templates/partials/flags/<flag_file>.svg.
LOCALE_DISPLAY = {
    "pt-BR": {"flag_file": "brazil", "label": "Português"},
    "en": {"flag_file": "usa", "label": "English"},
    "es": {"flag_file": "spain", "label": "Español"},
}


def _load_translations(locale: str) -> dict:
    """Carrega (e mantém em cache) o dicionário de traduções de um idioma.
    Assume que ``locale`` já foi validado contra ``Config.SUPPORTED_LOCALES``
    pelo chamador."""
    if locale not in _translations_cache:
        path = os.path.join(_TRANSLATIONS_DIR, f"{locale}.json")
        with open(path, "r", encoding="utf-8") as f:
            _translations_cache[locale] = json.load(f)
    return _translations_cache[locale]


def resolve_locale() -> str:
    """Determina o idioma do visitante para o request Flask em curso, na
    ordem de prioridade descrita no docstring do módulo."""
    cookie_value = request.cookies.get(Config.LOCALE_COOKIE_NAME)
    if cookie_value in Config.SUPPORTED_LOCALES:
        return cookie_value

    accept_language_match = request.accept_languages.best_match(Config.SUPPORTED_LOCALES)
    if accept_language_match:
        return accept_language_match

    country = (request.headers.get("CF-IPCountry") or "").strip().upper()
    locale_by_country = _COUNTRY_TO_LOCALE.get(country)
    if locale_by_country in Config.SUPPORTED_LOCALES:
        return locale_by_country

    return Config.DEFAULT_LOCALE


def _lookup(translations: dict, dotted_key: str):
    """Navega um dict aninhado usando uma chave tipo ``room.title_host``.
    Retorna ``None`` se qualquer nível do caminho não existir."""
    value = translations
    for part in dotted_key.split("."):
        if not isinstance(value, dict) or part not in value:
            return None
        value = value[part]
    return value


def translate(locale: str, key: str, **kwargs) -> str:
    """Traduz ``key`` (formato ``"namespace.chave"``) para ``locale``.

    Cai para ``Config.DEFAULT_LOCALE`` se a chave não existir no idioma
    pedido (tradução esquecida/incompleta). Se a chave não existir nem no
    idioma fonte, devolve a própria chave entre colchetes — isso nunca
    deveria acontecer em produção (é sinal de chave digitada errado), mas é
    preferível a quebrar a página.
    """
    translations = _load_translations(locale) if locale in Config.SUPPORTED_LOCALES else {}
    value = _lookup(translations, key)

    if value is None and locale != Config.DEFAULT_LOCALE:
        value = _lookup(_load_translations(Config.DEFAULT_LOCALE), key)

    if value is None:
        return f"[{key}]"

    return value.format(**kwargs) if kwargs else value


def _deep_merge(base: dict, override: dict) -> dict:
    """Mescla ``override`` sobre ``base`` recursivamente (chave a chave, não
    substitui um sub-dict inteiro por outro incompleto)."""
    merged = dict(base)
    for key, value in override.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def get_full_translations(locale: str) -> dict:
    """Retorna o dicionário de traduções completo para ``locale``, com
    qualquer chave ausente já preenchida a partir de ``Config.DEFAULT_LOCALE``.

    Usado pra expor as traduções de uma vez só ao JS do navegador (embutidas
    na página, ver ``i18n_json`` em ``app.py`` e ``i18n-client.js``) — o
    cliente não precisa reimplementar a lógica de fallback por chave, já
    recebe um dicionário completo pronto pra consulta direta.
    """
    base = _load_translations(Config.DEFAULT_LOCALE)
    if locale == Config.DEFAULT_LOCALE or locale not in Config.SUPPORTED_LOCALES:
        return base
    return _deep_merge(base, _load_translations(locale))


def get_all_translations() -> dict:
    """Retorna o dicionário completo (já com fallback) de TODOS os idiomas
    suportados, um por chave de locale — ex: ``{"pt-BR": {...}, "en": {...}}``.

    Usado só nas páginas com troca de idioma ao vivo sem reload (ver
    ``language-switcher.js``): o navegador já recebe as traduções dos 3
    idiomas de uma vez, então trocar de idioma no seletor é só reler esse
    dicionário local, sem precisar de outra ida ao servidor.
    """
    return {locale: get_full_translations(locale) for locale in Config.SUPPORTED_LOCALES}
