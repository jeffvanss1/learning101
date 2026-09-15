// i18n.js — country-driven UI language (worker-injected WP_GEO) + dictionaries.
//
// The WORKER resolves the locale per request (see src/geo.js) from
// Cloudflare's `request.cf.country` and injects `window.WP_GEO` into every
// HTML response. This module:
//   1. resolves the UI language:  ?lang= / saved override  >  WP_GEO (IP
//      country)  >  browser languages  >  'en'
//   2. applies translations to [data-i18n] (textContent) and
//      [data-i18n-placeholder] (placeholder attribute) elements
//   3. sets <html lang> and <html dir> (rtl for Arabic)
//   4. exposes WP.I18N.t(key, fallback) for strings created in JS
//
// NOTE: the country→language map lives in the worker (src/geo.js) — this file
// only ships the dictionaries, so a stale worker simply degrades to the
// browser-language fallback (never breaks).
//
// @ts-check
(function (global) {
  'use strict';

  const WP = global.WP || {};

  /** UI languages with dictionaries (must mirror SUPPORTED_UI_LANGS in src/geo.js). */
  const SUPPORTED = ['en', 'id', 'es', 'fr', 'pt', 'ar'];
  const RTL = ['ar'];
  const LANG_PREF_KEY = 'wp:lang';

  /** @type {Record<string, Record<string, string>>} */
  const DICTS = {
    en: {
      'nav.home': 'Home',
      'nav.movies': 'Movies',
      'nav.series': 'Series',
      'nav.anime': 'Anime',
      'nav.friends': 'Friends',
      'nav.more': 'More',
      'nav.history': 'Watch history',
      'nav.trending': 'Trending Now',
      'nav.topMovies': 'Top Rated Movies',
      'nav.topSeries': 'Top Rated Series',
      'nav.theaters': 'In Theaters',
      'nav.airing': 'Airing Today',
      'nav.startRoom': 'Start a room',
      'heading.menu': 'Menu',
      'heading.library': 'Library',
      'action.join': 'Join',
      'search.placeholder': 'Search movies & series\u2026',
      'search.placeholderSide': 'Search',
      'history.title': 'Watch history',
      'history.clear': 'Clear',
      'name.title': 'What should we call you?',
      'name.label': 'Your name',
      'name.continue': 'Continue',
      'name.haveCode': 'Have an access code? Sign in instead',
      'code.label': 'Access code',
      'code.hint': 'The code you saved when your profile was created.',
      'code.signin': 'Sign in',
      'code.useNew': 'Use a new name instead',
      'card.watchTogether': 'Watch together',
      'card.details': 'Details',
      'feed.loading': 'Loading\u2026',
      'feed.noResults': 'No results \u2014 try another title.',
      'discovery.sub': 'Keep scrolling \u2014 more titles load automatically.',
      'subs.title': 'Subtitles',
      'subs.load': 'Auto-load',
      'subs.loading': 'Finding subtitles…',
      'subs.none': 'No subtitles found for this title.',
      'subs.loaded': 'Loaded',
      'subs.offset': 'Offset',
      'subs.reset': 'Reset offset',
      'subs.size': 'Size',
      'subs.toggle': 'On/Off',
      'subs.hint': 'Keys: [ delay · ] advance (while the panel is open)',
      'subs.fallback': 'no {lang} subs — language fallback',
      'subs.noneAny': 'No subtitles found at all for this title.',
      'subs.tapSync': 'Sync',
      'subs.tapNow': 'TAP NOW',
      'subs.tapListen': 'Listen for',
      'subs.tapWhen': 'tap when you hear it',
      'subs.tapDone': 'Synced',
      'subs.persisted': 'saved for this title',
      'subs.noneDownloadable': 'Subtitles exist but none are downloadable with this API key/plan.',
      'subs.gated': 'Found {n} subtitles, but they sit behind a provider approval gate. Upload an .srt meanwhile — it works instantly.',
      'subs.snapHint': 'Press exactly when someone starts speaking — the next line snaps to now.',
      'subs.snapAgain': 'Still off? Press again while someone speaks.',
      'subs.editorEmpty': 'Load subtitles to see their timing here.',
      'subs.editorHint': 'Tap a line, then align it to where you are.',
      'subs.align': 'Align to playhead',
      'subs.alignHint': 'Makes this line start right now.',
      'subs.byHost': 'loaded by host',
      'subs.byHostMatch': 'matched by host',
      'subs.now': 'now',
      'subs.snapNoClock': 'Start playback first, then sync.',
      'subs.snapAtEnd': 'No more lines ahead — rewind a little to sync.',
    },
    id: {
      'nav.home': 'Beranda',
      'nav.movies': 'Film',
      'nav.series': 'Serial',
      'nav.anime': 'Anime',
      'nav.friends': 'Teman',
      'nav.more': 'Lainnya',
      'nav.history': 'Riwayat tontonan',
      'nav.trending': 'Sedang Tren',
      'nav.topMovies': 'Film Rating Tertinggi',
      'nav.topSeries': 'Serial Rating Tertinggi',
      'nav.theaters': 'Di Bioskop',
      'nav.airing': 'Tayang Hari Ini',
      'nav.startRoom': 'Mulai ruangan',
      'heading.menu': 'Menu',
      'heading.library': 'Pustaka',
      'action.join': 'Gabung',
      'search.placeholder': 'Cari film & serial\u2026',
      'search.placeholderSide': 'Cari',
      'history.title': 'Riwayat tontonan',
      'history.clear': 'Hapus',
      'name.title': 'Siapa nama kita?',
      'name.label': 'Namamu',
      'name.continue': 'Lanjut',
      'name.haveCode': 'Punya kode akses? Masuk sebagai gantinya',
      'code.label': 'Kode akses',
      'code.hint': 'Kode yang kamu simpan saat profil dibuat.',
      'code.signin': 'Masuk',
      'code.useNew': 'Pakai nama baru',
      'card.watchTogether': 'Tonton bersama',
      'card.details': 'Detail',
      'feed.loading': 'Memuat\u2026',
      'feed.noResults': 'Tidak ada hasil \u2014 coba judul lain.',
      'discovery.sub': 'Terus gulir \u2014 judul lain dimuat otomatis.',
      'subs.title': 'Subtitle',
      'subs.load': 'Muat otomatis',
      'subs.loading': 'Mencari subtitle…',
      'subs.none': 'Tidak ada subtitle untuk judul ini.',
      'subs.loaded': 'Dimuat',
      'subs.offset': 'Geser',
      'subs.reset': 'Reset geseran',
      'subs.size': 'Ukuran',
      'subs.toggle': 'Nyala/Mati',
      'subs.hint': 'Tombol: [ tunda · ] majukan (saat panel terbuka)',
      'subs.fallback': 'tidak ada sub {lang} — pakai bahasa lain',
      'subs.noneAny': 'Tidak ada subtitle sama sekali untuk judul ini.',
      'subs.tapSync': 'Sinkron',
      'subs.tapNow': 'TEKAN SEKARANG',
      'subs.tapListen': 'Dengarkan',
      'subs.tapWhen': 'tekan saat kamu mendengarnya',
      'subs.tapDone': 'Sinkron',
      'subs.persisted': 'tersimpan untuk judul ini',
      'subs.noneDownloadable': 'Ada subtitle tetapi tidak ada yang bisa diunduh dengan key/paket API ini.',
      'subs.gated': 'Ditemukan {n} subtitle, tetapi masih di belakang gerbang persetujuan penyedia. Unggah .srt dulu — langsung berfungsi.',
      'subs.snapHint': 'Tekan tepat saat seseorang mulai berbicara — baris berikutnya langsung disesuaikan.',
      'subs.snapAgain': 'Masih belum pas? Tekan lagi saat ada yang berbicara.',
      'subs.editorEmpty': 'Muat subtitle untuk melihat timing-nya di sini.',
      'subs.editorHint': 'Ketuk sebuah baris, lalu sejajarkan dengan posisimu.',
      'subs.align': 'Sejajarkan ke sekarang',
      'subs.alignHint': 'Baris ini mulai tepat sekarang.',
      'subs.byHost': 'dimuat oleh host',
      'subs.byHostMatch': 'disesuaikan oleh host',
      'subs.now': 'sekarang',
      'subs.snapNoClock': 'Putar videonya dulu, lalu sinkronkan.',
      'subs.snapAtEnd': 'Tidak ada baris lagi di depan — mundurkan sedikit untuk sinkron.',
    },
    es: {
      'nav.home': 'Inicio',
      'nav.movies': 'Pel\u00edculas',
      'nav.series': 'Series',
      'nav.anime': 'Anime',
      'nav.friends': 'Amigos',
      'nav.more': 'M\u00e1s',
      'nav.history': 'Historial',
      'nav.trending': 'Tendencias',
      'nav.topMovies': 'Pel\u00edculas mejor valoradas',
      'nav.topSeries': 'Series mejor valoradas',
      'nav.theaters': 'En cines',
      'nav.airing': 'Emiti\u00e9ndose hoy',
      'nav.startRoom': 'Crear sala',
      'heading.menu': 'Men\u00fa',
      'heading.library': 'Biblioteca',
      'action.join': 'Unirse',
      'search.placeholder': 'Buscar pel\u00edculas y series\u2026',
      'search.placeholderSide': 'Buscar',
      'history.title': 'Historial de visualizaci\u00f3n',
      'history.clear': 'Borrar',
      'name.title': '\u00bfC\u00f3mo te llamamos?',
      'name.label': 'Tu nombre',
      'name.continue': 'Continuar',
      'name.haveCode': '\u00bfTienes un c\u00f3digo de acceso? Inicia sesi\u00f3n',
      'code.label': 'C\u00f3digo de acceso',
      'code.hint': 'El c\u00f3digo que guardaste al crear tu perfil.',
      'code.signin': 'Iniciar sesi\u00f3n',
      'code.useNew': 'Usar un nombre nuevo',
      'card.watchTogether': 'Ver juntos',
      'card.details': 'Detalles',
      'feed.loading': 'Cargando\u2026',
      'feed.noResults': 'Sin resultados \u2014 prueba otro t\u00edtulo.',
      'discovery.sub': 'Sigue desplaz\u00e1ndote: se cargan m\u00e1s t\u00edtulos autom\u00e1ticamente.',
      'subs.title': 'Subtítulos',
      'subs.load': 'Carga automática',
      'subs.loading': 'Buscando subtítulos…',
      'subs.none': 'No hay subtítulos para este título.',
      'subs.loaded': 'Cargado',
      'subs.offset': 'Desfase',
      'subs.reset': 'Reiniciar desfase',
      'subs.size': 'Tamaño',
      'subs.toggle': 'Sí/No',
      'subs.hint': 'Teclas: [ retrasar · ] adelantar (panel abierto)',
      'subs.fallback': 'sin subs en {lang} — cambio de idioma',
      'subs.noneAny': 'No se encontraron subtítulos para este título.',
      'subs.tapSync': 'Sincronizar',
      'subs.tapNow': '¡TOCA AHORA!',
      'subs.tapListen': 'Escucha',
      'subs.tapWhen': 'toca cuando lo oigas',
      'subs.tapDone': 'Sincronizado',
      'subs.persisted': 'guardado para este título',
      'subs.noneDownloadable': 'Hay subtítulos pero ninguno se puede descargar con esta clave/plan.',
      'subs.gated': 'Se encontraron {n} subtítulos, pero están tras una puerta de aprobación del proveedor. Sube un .srt mientras tanto: funciona al instante.',
      'subs.snapHint': 'Pulsa justo cuando alguien empiece a hablar: la siguiente línea se ajusta al instante.',
      'subs.snapAgain': '¿Sigue desfasado? Úsalo de nuevo mientras alguien hable.',
      'subs.editorEmpty': 'Carga subtítulos para ver sus tiempos aquí.',
      'subs.editorHint': 'Toca una línea y alinéala con donde vas.',
      'subs.align': 'Alinear al playhead',
      'subs.alignHint': 'Hace que esta línea empiece ahora mismo.',
      'subs.byHost': 'cargado por el anfitrión',
      'subs.byHostMatch': 'ajustado por el anfitrión',
      'subs.now': 'ahora',
      'subs.snapNoClock': 'Reproduce el vídeo primero y luego sincroniza.',
      'subs.snapAtEnd': 'No quedan líneas por delante: rebobina un poco para sincronizar.',
    },
    fr: {
      'nav.home': 'Accueil',
      'nav.movies': 'Films',
      'nav.series': 'S\u00e9ries',
      'nav.anime': 'Anime',
      'nav.friends': 'Amis',
      'nav.more': 'Plus',
      'nav.history': 'Historique',
      'nav.trending': 'Tendances',
      'nav.topMovies': 'Films les mieux not\u00e9s',
      'nav.topSeries': 'S\u00e9ries les mieux not\u00e9es',
      'nav.theaters': 'Au cin\u00e9ma',
      'nav.airing': "Diffus\u00e9s aujourd'hui",
      'nav.startRoom': 'Lancer un salon',
      'heading.menu': 'Menu',
      'heading.library': 'Biblioth\u00e8que',
      'action.join': 'Rejoindre',
      'search.placeholder': 'Rechercher des films et s\u00e9ries\u2026',
      'search.placeholderSide': 'Rechercher',
      'history.title': 'Historique de visionnage',
      'history.clear': 'Effacer',
      'name.title': 'Comment doit-on t\u2019appeler ?',
      'name.label': 'Ton nom',
      'name.continue': 'Continuer',
      'name.haveCode': 'Un code d\u2019acc\u00e8s ? Connecte-toi plut\u00f4t',
      'code.label': 'Code d\u2019acc\u00e8s',
      'code.hint': 'Le code enregistr\u00e9 \u00e0 la cr\u00e9ation de ton profil.',
      'code.signin': 'Se connecter',
      'code.useNew': 'Utiliser un nouveau nom',
      'card.watchTogether': 'Regarder ensemble',
      'card.details': 'D\u00e9tails',
      'feed.loading': 'Chargement\u2026',
      'feed.noResults': 'Aucun r\u00e9sultat \u2014 essayez un autre titre.',
      'discovery.sub': 'Continuez \u00e0 faire d\u00e9filer \u2014 d\u2019autres titres arrivent automatiquement.',
      'subs.title': 'Sous-titres',
      'subs.load': 'Chargement auto',
      'subs.loading': 'Recherche de sous-titres…',
      'subs.none': 'Aucun sous-titre trouvé pour ce titre.',
      'subs.loaded': 'Chargé',
      'subs.offset': 'Décalage',
      'subs.reset': 'Réinitialiser le décalage',
      'subs.size': 'Taille',
      'subs.toggle': 'On/Off',
      'subs.hint': 'Touches : [ retarder · ] avancer (panneau ouvert)',
      'subs.fallback': 'pas de sous-titres {lang} — autre langue utilisée',
      'subs.noneAny': 'Aucun sous-titre trouvé pour ce titre.',
      'subs.tapSync': 'Synchro',
      'subs.tapNow': 'TAPEZ MAINTENANT',
      'subs.tapListen': 'Écoutez',
      'subs.tapWhen': 'tapez quand vous l’entendez',
      'subs.tapDone': 'Synchronisé',
      'subs.persisted': 'enregistré pour ce titre',
      'subs.noneDownloadable': 'Des sous-titres existent mais aucun n’est téléchargeable avec cette clé/ce plan.',
      'subs.gated': '{n} sous-titres trouvés, mais derrière une barrière d’approbation de fournisseur. Déposez un .srt en attendant — ça marche immédiatement.',
      'subs.snapHint': 'Appuyez pile quand quelqu’un commence à parler — la prochaine ligne se cale sur maintenant.',
      'subs.snapAgain': 'Toujours décalé ? Réutilisez-le pendant que quelqu’un parle.',
      'subs.editorEmpty': 'Chargez des sous-titres pour voir leur minutage ici.',
      'subs.editorHint': 'Touchez une ligne, puis alignez-la sur votre position.',
      'subs.align': 'Aligner sur la lecture',
      'subs.alignHint': 'Fait démarrer cette ligne maintenant.',
      'subs.byHost': 'chargé par l’hôte',
      'subs.byHostMatch': 'calé par l’hôte',
      'subs.now': 'maintenant',
      'subs.snapNoClock': 'Lance d’abord la lecture, puis synchronisez.',
      'subs.snapAtEnd': 'Plus de ligne à venir — rembobinez un peu pour synchroniser.',
    },
    pt: {
      'nav.home': 'In\u00edcio',
      'nav.movies': 'Filmes',
      'nav.series': 'S\u00e9ries',
      'nav.anime': 'Anime',
      'nav.friends': 'Amigos',
      'nav.more': 'Mais',
      'nav.history': 'Hist\u00f3rico',
      'nav.trending': 'Em alta',
      'nav.topMovies': 'Filmes mais bem avaliados',
      'nav.topSeries': 'S\u00e9ries mais bem avaliadas',
      'nav.theaters': 'Nos cinemas',
      'nav.airing': 'Exibindo hoje',
      'nav.startRoom': 'Iniciar sala',
      'heading.menu': 'Menu',
      'heading.library': 'Biblioteca',
      'action.join': 'Entrar',
      'search.placeholder': 'Pesquisar filmes e s\u00e9ries\u2026',
      'search.placeholderSide': 'Pesquisar',
      'history.title': 'Hist\u00f3rico de exibi\u00e7\u00e3o',
      'history.clear': 'Limpar',
      'name.title': 'Como devemos te chamar?',
      'name.label': 'Seu nome',
      'name.continue': 'Continuar',
      'name.haveCode': 'Tem um c\u00f3digo de acesso? Entre em vez disso',
      'code.label': 'C\u00f3digo de acesso',
      'code.hint': 'O c\u00f3digo que voc\u00ea salvou quando criou o perfil.',
      'code.signin': 'Entrar',
      'code.useNew': 'Usar um novo nome',
      'card.watchTogether': 'Assistir juntos',
      'card.details': 'Detalhes',
      'feed.loading': 'Carregando\u2026',
      'feed.noResults': 'Nenhum resultado \u2014 tente outro t\u00edtulo.',
      'discovery.sub': 'Continue rolando \u2014 mais t\u00edtulos carregam automaticamente.',
      'subs.title': 'Legendas',
      'subs.load': 'Carregar automático',
      'subs.loading': 'Procurando legendas…',
      'subs.none': 'Nenhuma legenda encontrada para este título.',
      'subs.loaded': 'Carregada',
      'subs.offset': 'Ajuste',
      'subs.reset': 'Zerar ajuste',
      'subs.size': 'Tamanho',
      'subs.toggle': 'Liga/Desliga',
      'subs.hint': 'Teclas: [ atrasar · ] adiantar (painel aberto)',
      'subs.fallback': 'sem legendas em {lang} — usando outro idioma',
      'subs.noneAny': 'Nenhuma legenda encontrada para este título.',
      'subs.tapSync': 'Sincronizar',
      'subs.tapNow': 'TOQUE AGORA',
      'subs.tapListen': 'Ouça',
      'subs.tapWhen': 'toque quando ouvir',
      'subs.tapDone': 'Sincronizada',
      'subs.persisted': 'salvo para este título',
      'subs.noneDownloadable': 'Existem legendas, mas nenhuma pode ser baixada com esta chave/plano.',
      'subs.gated': 'Encontradas {n} legendas, mas atrás de um portão de aprovação do provedor. Envie um .srt enquanto isso — funciona na hora.',
      'subs.snapHint': 'Toque exatamente quando alguém começar a falar — a próxima linha se ajusta ao agora.',
      'subs.snapAgain': 'Ainda fora de sincronia? Use de novo enquanto alguém fala.',
      'subs.editorEmpty': 'Carregue legendas para ver os tempos aqui.',
      'subs.editorHint': 'Toque numa linha e alinhe-a à sua posição.',
      'subs.align': 'Alinhar ao playhead',
      'subs.alignHint': 'Faz esta linha começar agora.',
      'subs.byHost': 'carregado pelo anfitrião',
      'subs.byHostMatch': 'ajustado pelo anfitrião',
      'subs.now': 'agora',
      'subs.snapNoClock': 'Dê play primeiro, depois sincronize.',
      'subs.snapAtEnd': 'Não há mais linhas à frente — volte um pouco para sincronizar.',
    },
    ar: {
      'nav.home': '\u0627\u0644\u0631\u0626\u064a\u0633\u064a\u0629',
      'nav.movies': '\u0623\u0641\u0644\u0627\u0645',
      'nav.series': '\u0645\u0633\u0644\u0633\u0644\u0627\u062a',
      'nav.anime': '\u0623\u0646\u0645\u064a',
      'nav.friends': '\u0627\u0644\u0623\u0635\u062f\u0642\u0627\u0621',
      'nav.more': '\u0627\u0644\u0645\u0632\u064a\u062f',
      'nav.history': '\u0633\u062c\u0644 \u0627\u0644\u0645\u0634\u0627\u0647\u062f\u0629',
      'nav.trending': '\u0627\u0644\u0631\u0627\u0626\u062c \u0627\u0644\u0622\u0646',
      'nav.topMovies': '\u0627\u0644\u0623\u0641\u0644\u0627\u0645 \u0627\u0644\u0623\u0639\u0644\u0649 \u062a\u0642\u064a\u064a\u0645\u0627\u064b',
      'nav.topSeries': '\u0627\u0644\u0645\u0633\u0644\u0633\u0644\u0627\u062a \u0627\u0644\u0623\u0639\u0644\u0649 \u062a\u0642\u064a\u064a\u0645\u0627\u064b',
      'nav.theaters': '\u0641\u064a \u0627\u0644\u0633\u064a\u0646\u0645\u0627\u062a',
      'nav.airing': '\u064a\u064f\u0639\u0631\u0636 \u0627\u0644\u064a\u0648\u0645',
      'nav.startRoom': '\u0627\u0628\u062f\u0623 \u063a\u0631\u0641\u0629',
      'heading.menu': '\u0627\u0644\u0642\u0627\u0626\u0645\u0629',
      'heading.library': '\u0627\u0644\u0645\u0643\u062a\u0628\u0629',
      'action.join': '\u0627\u0646\u0636\u0645',
      'search.placeholder': '\u0627\u0628\u062d\u062b \u0639\u0646 \u0623\u0641\u0644\u0627\u0645 \u0648\u0645\u0633\u0644\u0633\u0644\u0627\u062a\u2026',
      'search.placeholderSide': '\u0628\u062d\u062b',
      'history.title': '\u0633\u062c\u0644 \u0627\u0644\u0645\u0634\u0627\u0647\u062f\u0629',
      'history.clear': '\u0645\u0633\u062d',
      'name.title': '\u0645\u0627 \u0627\u0633\u0645\u0643\u061f',
      'name.label': '\u0627\u0633\u0645\u0643',
      'name.continue': '\u0645\u062a\u0627\u0628\u0639\u0629',
      'name.haveCode': '\u0644\u062f\u064a\u0643 \u0631\u0645\u0632 \u0648\u0635\u0648\u0644\u061f \u0633\u062c\u0651\u0644 \u0627\u0644\u062f\u062e\u0648\u0644 \u0628\u062f\u0644\u0627\u064b \u0645\u0646 \u0630\u0644\u0643',
      'code.label': '\u0631\u0645\u0632 \u0627\u0644\u0648\u0635\u0648\u0644',
      'code.hint': '\u0627\u0644\u0631\u0645\u0632 \u0627\u0644\u0630\u064a \u062d\u0641\u0638\u062a\u0647 \u0639\u0646\u062f \u0625\u0646\u0634\u0627\u0621 \u0645\u0644\u0641\u0643 \u0627\u0644\u0634\u062e\u0635\u064a.',
      'code.signin': '\u062a\u0633\u062c\u064a\u0644 \u0627\u0644\u062f\u062e\u0648\u0644',
      'code.useNew': '\u0627\u0633\u062a\u062e\u062f\u0627\u0645 \u0627\u0633\u0645 \u062c\u062f\u064a\u062f',
      'card.watchTogether': '\u0645\u0634\u0627\u0647\u062f\u0629 \u0645\u0639\u0627\u064b',
      'card.details': '\u062a\u0641\u0627\u0635\u064a\u0644',
      'feed.loading': '\u062c\u0627\u0631\u064d \u0627\u0644\u062a\u062d\u0645\u064a\u0644\u2026',
      'feed.noResults': '\u0644\u0627 \u062a\u0648\u062c\u062f \u0646\u062a\u0627\u0626\u062c \u2014 \u062c\u0631\u0651\u0628 \u0639\u0646\u0648\u0627\u0646\u0627\u064b \u0622\u062e\u0631.',
      'discovery.sub': '\u0627\u0633\u062a\u0645\u0631 \u0641\u064a \u0627\u0644\u062a\u0645\u0631\u064a\u0631 \u2014 \u064a\u062a\u0645 \u062a\u062d\u0645\u064a\u0644 \u0627\u0644\u0645\u0632\u064a\u062f \u062a\u0644\u0642\u0627\u0626\u064a\u0627\u064b.',
      'subs.title': 'الترجمات',
      'subs.load': 'تحميل تلقائي',
      'subs.loading': 'جارٍ البحث عن ترجمات…',
      'subs.none': 'لا توجد ترجمات لهذا العنوان.',
      'subs.loaded': 'تم التحميل',
      'subs.offset': 'الإزاحة',
      'subs.reset': 'تصفير الإزاحة',
      'subs.size': 'الحجم',
      'subs.toggle': 'تشغيل/إيقاف',
      'subs.hint': 'المفاتيح: [ تأخير · ] تقديم (أثناء فتح اللوحة)',
      'subs.fallback': 'لا توجد ترجمات بـ{lang} — تم استخدام لغة أخرى',
      'subs.noneAny': 'لا توجد ترجمات لهذا العنوان إطلاقًا.',
      'subs.tapSync': 'مزامنة',
      'subs.tapNow': 'اضغط الآن',
      'subs.tapListen': 'استمع إلى',
      'subs.tapWhen': 'اضغط عندما تسمعها',
      'subs.tapDone': 'تمت المزامنة',
      'subs.persisted': 'محفوظ لهذا العنوان',
      'subs.noneDownloadable': 'توجد ترجمات لكن لا يمكن تنزيل أي منها بهذا المفتاح/الخطة.',
      'subs.gated': 'تم العثور على {n} ترجمات لكنها خلف بوابة موافقة المزوّد. ارفع ملف srt في هذه الأثناء — يعمل فورًا.',
      'subs.snapHint': 'اضغط لحظة أن يبدأ أحد بالكلام — سيُثبَّت السطر التالي على الآن.',
      'subs.snapAgain': 'ما زال غير متزامن؟ استخدمه مرة أخرى أثناء الكلام.',
      'subs.editorEmpty': 'حمّل ترجمات لرؤية توقيتها هنا.',
      'subs.editorHint': 'انقر على سطر ثم اضبطه على موضعك الحالي.',
      'subs.align': 'محاذاة إلى المؤشر',
      'subs.alignHint': 'يجعل هذا السطر يبدأ الآن.',
      'subs.byHost': 'حمّلها المضيف',
      'subs.byHostMatch': 'ضبطها المضيف',
      'subs.now': 'الآن',
      'subs.snapNoClock': 'شغّل الفيديو أولاً ثم زامن.',
      'subs.snapAtEnd': 'لا مزيد من الأسطر القادمة — أرجِع قليلاً للمزامنة.',
    },
  };

  /** @type {string} */
  let currentLang = 'en';

  /**
   * Resolve the UI language: override (?lang= / saved) > worker-injected
   * IP-country locale > browser languages > 'en'.
   * @returns {string}
   */
  function resolve() {
    let override = '';
    try {
      const params = new URLSearchParams(global.location && global.location.search ? global.location.search : '');
      override = (params.get('lang') || '').trim().toLowerCase();
      if (override) global.localStorage.setItem(LANG_PREF_KEY, override);
      else override = global.localStorage.getItem(LANG_PREF_KEY) || '';
    } catch (_) {}
    if (SUPPORTED.indexOf(override) !== -1) return override;

    const geo = /** @type {any} */ (global.WP_GEO);
    if (geo && SUPPORTED.indexOf(geo.uiLang) !== -1) return geo.uiLang;

    const nav = /** @type {any} */ (typeof navigator !== 'undefined' ? navigator : null);
    const langs = (nav && nav.languages ? nav.languages : nav && nav.language ? [nav.language] : []);
    for (const tag of /** @type {string[]} */ (langs)) {
      const base = String(tag).toLowerCase().split('-')[0];
      if (SUPPORTED.indexOf(base) !== -1) return base;
    }
    return 'en';
  }

  /**
   * Translate a key (falls back to the provided English default).
   * @param {string} key
   * @param {string} fallback
   * @returns {string}
   */
  function t(key, fallback) {
    const dict = DICTS[currentLang] || DICTS.en;
    return dict[key] || DICTS.en[key] || fallback;
  }

  /** Apply dictionaries to the DOM (static chrome) + <html lang/dir>. */
  function apply() {
    currentLang = resolve();
    const dict = DICTS[currentLang] || DICTS.en;
    const doc = global.document;
    if (doc && doc.documentElement) {
      doc.documentElement.lang = currentLang;
      doc.documentElement.dir = RTL.indexOf(currentLang) !== -1 ? 'rtl' : 'ltr';
    }
    if (!doc || !doc.querySelectorAll) return;
    doc.querySelectorAll('[data-i18n]').forEach((/** @type {any} */ el) => {
      const key = el.getAttribute('data-i18n');
      const translated = key && dict[key];
      if (translated) el.textContent = translated;
    });
    doc.querySelectorAll('[data-i18n-placeholder]').forEach((/** @type {any} */ el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      const translated = key && dict[key];
      if (translated) el.setAttribute('placeholder', translated);
    });
    try {
      const geoCountry = (/** @type {any} */ (global.WP_GEO) && global.WP_GEO.country) || 'no-geo';
      console.info('[WatchParty] Lang:', currentLang, '(' + geoCountry + ')');
    } catch (_) {}
  }

  /** @param {string} lang @returns {boolean} whether an override was saved */
  function setLanguage(lang) {
    const l = String(lang || '').trim().toLowerCase();
    if (SUPPORTED.indexOf(l) === -1) return false;
    try {
      global.localStorage.setItem(LANG_PREF_KEY, l);
    } catch (_) {}
    currentLang = l;
    apply();
    return true;
  }

  if (global.document && global.document.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', apply);
  } else {
    apply();
  }

  WP.I18N = { t: t, apply: apply, setLanguage: setLanguage, get language() { return currentLang; } };
  Object.defineProperty(WP.I18N, 'language', { get: function () {
    return currentLang;
  } });
  global.WP = WP;
})(window);
