# patchpath

Tek komut, tek rapor: npm projeniz için bilinen zafiyetler, kullanımdan kaldırılmış (deprecated) paketler ve eskimiş bağımlılıklar; her sorunu içeri çeken zincirle birlikte.

[English](README.md) | Türkçe

patchpath bağımlılıklarınızın **kodunu yamalamaz** (patch-package gibi araçlardan farklı olarak); yükseltme yolunu ve izlenecek komutları önerir.

> Durum: erken sürüm (v0.1.0). `package-lock.json` dosyasını okur; `yarn.lock` (yarn v1) ve `pnpm-lock.yaml` (lockfile v9) dosyalarını ise yükseltme planı olmadan okur ([Lockfile'lar](#lockfilelar)). npm'den kurabilir veya depodan derleyebilirsiniz ([Kurulum](#kurulum)).

Bu belge İngilizce [README.md](README.md) ile aynı içeriği taşır; ikisi arasında fark görürseniz İngilizce sürüm esastır.

## Neden var, ne yapmaz

`npm audit`, kurulu paketlerden hangilerinde bilinen bir zafiyet bulunduğunu söyler. Sorun üç seviye aşağıdaysa, doğrudan bağımlılıklarınızdan hangisine dokunmanız gerektiğini kendiniz çözmeniz gerekir. patchpath aynı türden veriyi okur ve üstüne bir görünüm ekler:

- her zafiyetli paketi içeri çeken **zincir** (`via`);
- düzeltmeleri, yükselteceğiniz doğrudan bağımlılığa göre gruplayan ve çalıştırmaya hazır komutlar veren bir **yükseltme planı**;
- kullanımdan kaldırılmış paketler ve bir ana sürüm geride kalan doğrudan bağımlılıklar, aynı raporda.

**Yeni bir zafiyet veritabanı değildir.** Zafiyet kayıtları [OSV](https://osv.dev)'den gelir (OSV, diğerlerinin yanında GitHub advisory veritabanını da toplar); yani tespit özünde `npm audit` ile aynıdır, fark gruplama ve plandadır. Plan, kayıt defteri (registry) üst verisinden yapılan bir **tahmindir**, bir çözümleyici (resolver) çalıştırması değildir: uygulayın, sonra yeniden tarayın. patchpath kaynak kodunuzu okumaz, bir yükseltmenin kodunuzla uyumlu olduğunu denetlemez ve temiz bir rapor garanti değildir.

## Kurulum

Node 22 veya üzeri. Kurmadan çalıştırın:

```
npx patchpath            # bulunduğunuz dizini tara
npx patchpath ./my-app   # başka bir projeyi tara
```

Ya da `npm install -g patchpath` ile genel olarak kurun. Depodan derlemek için:

```
git clone https://github.com/serhat-10/patchpath.git
cd patchpath
npm install
npm run build
node dist/cli.js            # bulunduğunuz dizini tara
node dist/cli.js ./my-app   # başka bir projeyi tara
```

## Örnek

Küçük bir Express/socket.io projesinde (95 paket, 7 doğrudan) Ekim 2026'da yapılmış gerçek bir çalıştırmadan alıntı. İlk satır (lockfile yolu) çıkarılmıştır; `[...]` atlanan satırları gösterir. Sonuçlar OSV ve registry değiştikçe değişir. Çıktı aracın kendi dilindedir (İngilizce).

```
95 packages (7 direct), 1 direct dependency a major version behind

22 known vulnerabilities in 12 packages: 1 critical, 10 high, 4 moderate, 7 low

Upgrade plan (estimated from registry metadata: apply it, then scan again)
  express 4.18.2 -> 4.22.3: clears 14 advisories in 8 packages (worst critical), non-breaking
  socket.io 4.7.2 -> 4.8.0: clears 7 advisories in 3 packages (worst high), non-breaking
  cookie-parser 1.4.6: no upgrade clears its 1 advisory (none of the 1 newer releases tried clears any)
    the in-range npm update below clears 1 of them without changing cookie-parser
  in-range updates (package.json unchanged): clears 1 advisory (worst low), non-breaking: the npm update line below

Commands (in this order, then scan again)
  # 1. non-breaking, estimated to clear 22 of 22 advisories
  npm install -- express@4.22.3 socket.io@4.8.0
  npm update -- cookie-parser proxy-addr socket.io-adapter socket.io-parser

Findings
proxy-addr@2.0.7 (transitive) 1 advisory, worst critical: covered by upgrading express
path-to-regexp@0.1.7 (transitive) 3 advisories, worst high: covered by upgrading express
ws@8.11.0 (transitive) 3 advisories, worst high: covered by upgrading socket.io
[...]
```

Bir yükseltme kırıcıysa (breaking) veya peer-bağımlılık çakışması olasıysa, kırıcı olmayan adımdan sonra kendi komutu olarak yazdırılır ve üstünde `# name: may break (new major or 0.x minor)` yorum satırı bulunur.

## Ne yapar

- **Yükseltme planı:** zafiyetli olan veya zafiyetli bir şeyi içeri çeken her doğrudan bağımlılık için yükseltilecek sürüm, bunun kaç advisory'yi (kaç pakette, en kötü ciddiyetle) temizlediği, kırıcı bir sınırı geçip geçmediği ve neyin açık kaldığı. Hiçbir yükseltme işe yaramıyorsa bunu söyler; kurulu sürüm deprecated ise de belirtir (hedef daha yeni bir sürümse "installed version deprecated, upgrade to X", hedef yoksa "deprecated: replace it"). Bu bir **tahmindir** ([Yükseltme planı nasıl çalışır](#yükseltme-planı-nasıl-çalışır)): uygulayın, sonra yeniden tarayın. Planın düzelttiği paketler altındaki listede "covered" diye işaretlenir ve `overrides` bloğu yalnızca planın düzeltmediklerini listeler.
- **Zafiyetler**, [OSV](https://osv.dev)'den; o paketin her advisory'sinin etkilenen aralığının **dışındaki en küçük sürümle** birlikte. Kırıcı olmayan yükseltmeler tercih edilir; kırıcı bir sınırı geçen düzeltme (yeni bir ana sürüm, yeni bir `0.x` minor veya yeni bir `0.0.x` yama) "may break" diye etiketlenir.
- npm registry'den **deprecated paketler** ve **bir ana sürüm geride kalan doğrudan bağımlılıklar**. Geçişli (transitive) paketlerdeki gerilik raporlanmaz: onları siz seçmediniz. Gerilik, farklı olan semver konumunu adlandırır; bu yüzden `0.1.x` -> `0.2.0` "minor" fark sayılır, oysa yukarıdaki düzeltme etiketlemesi aynı adımı kırıcı sayar.
- **Nereden geldiği:** geçişli bir paket için, doğrudan bağımlılıktan ebeveynine kadar kurulu paketlerin zinciri (paketin kendisi tekrarlanmaz), `via <direct>@<version> > ... > <parent>@<version>` biçiminde yazdırılır. Örneğin `request@2.88.2` tarafından doğrudan çekilen bir `form-data`, `via request@2.88.2` olarak yazdırılır.
- **Overrides:** kırıcı sınırı geçmeyen geçişli düzeltmeler, yapıştırmaya hazır bir npm `overrides` bloğunda toplanır (bir paketin ne zaman dışarıda bırakıldığı için aşağıya bakın).
- **Kötü amaçlı kod:** kimliği (veya takma adlarından biri) `MAL-` ile başlayan bir advisory (özetler kullanılmaz: sıradan advisory'ler sık sık "malicious input" der) listede `MALWARE` diye etiketlenir, özette sayılır (`N malicious packages`, JSON'da `summary.malicious`) ve bir plan yükseltmesi o paketi kapsasa bile o satırda `MALICIOUS CODE (MAL-...)` olarak işaretlenir. Böyle bir paketi kaldırın; yalnızca yükseltmeyin.
- **Sıralama:** önce kötü amaçlı paketler, sonra en kötü zafiyet, sonra deprecation'lar. Aynı katmanda doğrudan geçişliden, production dev'den, çok advisory'si olan az olandan önce gelir.
- npm alias'ları, workspace'ler, v1/v2/v3 lockfile'lar. `devOptional` paketler (aynı zamanda production paketlerin opsiyonel bağımlılığı olan dev bağımlılıkları) production sayılır, çünkü `npm install --omit=dev` onları kurar. v1 lockfile'larda, production bağımlılıklarınızdan erişilebilen hiçbir şeyin istemediği girdiler (bir bağımlılığını bırakmış paketin altında kalan artıklar), `npm audit --omit=dev` gibi `--no-dev` tarafından production dışı sayılır; bunun için package.json lockfile'ın yanında olmalıdır.

### Yükseltme planı nasıl çalışır

Bir doğrudan bağımlılığın her aday sürümü için patchpath, registry'nin paket belgelerindeki sürüm başına `dependencies` verisini kullanarak, o sürümden aşağı doğru her zafiyetli paketin zincirini (`via`) yürür. Her adımda taze bir kurulumun seçeceğini seçer: bildirilen aralığı sağlıyorsa `latest` etiketini, aksi halde onu sağlayan en yeni deprecated olmayan sürümü (aralıklar [`semver`](https://www.npmjs.com/package/semver) paketiyle değerlendirilir, paket `dist` içine gömülüdür). Yeni bir sürüm bir sonraki pakete artık bağlı değilse, o paket "gitmiş" sayılır. Sonunda bulunan sürüm paketin bilinen advisory'lerine karşı denetlenir ve tahmin edilen her sürüm ayrıca OSV'ye gönderilir; böylece yeni sürümün **getireceği** advisory'ler gözden kaçmaz, kalan olarak sayılır.

Adaylar, doğrudan bağımlılığın deprecated olmayan ve prerelease olmayan daha yeni sürümleridir: kurulu sürümün kırıcı hattındaki en yeni 20 sürüm ve üstündeki en yeni 3 kırıcı hattın her birindeki en yeni 20 sürüm. Plan, her şeyi temizleyen en küçük kırıcı olmayan sürümü önerir; yoksa en az şey açık bırakan (ciddiyete göre ağırlıklı) kırıcı olmayan sürümü önerir ve varsa her şeyi temizleyecek en küçük kırıcı sürümü adlandırır; kırıcı olmayan hiçbir sürüm hiç yardımcı olmuyorsa en iyi kırıcı olanı önerir.

Bir tahmindir, resolver çalıştırması değildir. npm başka bir sonuca varabilir:

- **Kilitli sürümler:** `npm install <dep>@<version>`, yeni aralığı hâlâ sağlıyorsa kilitli bir geçişli sürümü korur. patchpath bunu tespit eder ve adı `npm update` satırına ekler (tahmin bunu çalıştıracağınızı varsayar; bir komut kapsamıyorsa plan satırı bunu yalnızca o zaman tekrarlar, JSON'da `alsoUpdate`).
- **Her zincir:** zafiyetli bir kopyaya giden lockfile'daki her bağımlılık kenarı izlenir. Başka bir kilitli ebeveynin hâlâ sabitlediği bir kopya, o ebeveyni aralık içinde güncellemek onu serbest bırakmadıkça kalan sayılır (bırakırsa ebeveyn `npm update`'e eklenir).
- **Aralık içi güncellemeler:** zafiyetli bir geçişli kopyanın düzeltilmiş sürümü ebeveynlerinin bildirdiği aralığın içindeyse (veya bir ebeveynin daha yeni aralık içi sürümünün aralığının içindeyse, en çok 3 seviye yukarıya kadar), plan package.json değişikliği olmadan `npm update <names>` ekler. `npm audit fix`'in çoğunlukla yaptığı budur. Bu satırlar **npm 7 veya üzeri** gerektirir: npm 6, `npm update` ile yalnızca doğrudan bağımlılıkların adlarını günceller ve geçişli olanları sessizce olduğu gibi bırakır.
- **Gömülü kopyalar** (`inBundle`) güncellenemez veya override edilemez; yalnızca onları gömen paket değiştiğinde değişirler.
- **Dedupe, peer bağımlılıklar ve overrides:** npm bağımlılar arasında tek bir kopyayı paylaştırabilir ve `overrides` uygulayabilir. Kök `overrides` içinde herhangi bir derinlikte (`{"express": {"qs": "6.5.1"}}` qs'i sabitler) veya bir aralıkla (`"qs@6"`) adı geçen bir paketin kurulu olduğu gibi kalacağı varsayılır ve plan hangi paketleri bir override'ın tuttuğunu söyler. Yeni bir sürümün eklediği paketler izlenmez. Her hedefin peer bağımlılıkları (registry'den) ve diğer doğrudan bağımlılıkların onun üzerinde bildirdiği peer bağımlılıklar (lockfile'dan) kurulu ağaca karşı denetlenir; olası çakışması olan bir yükseltme kırıcı olmayan komutun dışında tutulur ve etiketlenir.

`peerDependenciesMeta` içinde `optional` işaretli peer bağımlılıklar, opsiyonel peer yalnızca yükseltilen paketin kendisi onu çektiği için kuruluysa yükseltmeyi engellemez; başka bir şey onu kurulu tutuyor ve çakışıyorsa çakışma yine raporlanır.

Komutlar şu sırayla gelir: **kırıcı olmayan tek bir adım** (olası peer çakışması olmayan her kırıcı olmayan yükseltmenin `npm install`'ı, sonra aralık içi yenilemelerin `npm update`'i) ve ardından **her kırıcı veya çakışan yükseltme kendi komutu olarak**; böylece npm'in reddettiği (ERESOLVE) tek bir ana sürüm güvenli düzeltmeleri engellemez. Olası peer çakışması olan yükseltmeler sona gelir: npm bazen birini kabul eder ve sonraki her kurulumun ERESOLVE ile durduğu bir ağaç bırakır. Bu adımlar arasında yeniden tarayın. Aynı kapsamdaki bir doğrudan bağımlılık grubu aynı sürümde (örneğin `@angular/*` 14.2.0) tek komutta birlikte hareket eder. Kırıcı bir hedef, yeni ana sürümündeki deprecated olmayan ve bilinen advisory'si olmayan en yeni sürümdür, ilki değil.

- Paket argümanları `--`'den sonra gelir; böylece içlerindeki hiçbir şey bir npm seçeneği olarak okunamaz. Adı npm'in kabul etmeyeceği lockfile girdileri (kabuk karakterleri, baştaki `-`, ...) asla denetlenmez veya komuta konmaz; bir uyarı bunları listeler ve denetlenmemiş sayılırlar.
- Bir workspace'in bildirdiği bağımlılık orada kurulur: `npm install -w packages/a -- name@version` (workspace başına bir satır; hem kökün hem bir workspace'in bildirdiği paket ikisini de alır). `npm update` satırı kökten çalışır ve workspace'lerin geçişli paketlerine de ulaşır.
- Bir npm alias'ı (`"sio4": "npm:socket.io-client@4.0.0"`) kendi başına planlanır ve `sio4@npm:socket.io-client@4.1.0` olarak kurulur; gerçek adla veya başka bir alias'la asla birleşmez.
- Yalnızca projenizin `peerDependency`'si olan bir paket (bir kütüphane) asla kırıcı olmayan adımda yer almaz: `npm install` package.json'daki aralığını yükseltirdi, bu da kullanıcılarınız için bir gereksinimdir. Etiketli, kendi komutunu alır.
- Zaten bir peer çakışması varsa (ve adım onu çözmüyorsa), `npm install` ve `npm update` ERESOLVE ile durur; bu yüzden kırıcı olmayan adımın iki satırı da `--legacy-peer-deps` taşır. Lockfile yalnızca peer olarak kurulmuş paketler içeriyorsa (`"peer": true`), bu bayrak onları kaldırırdı; bu yüzden adım çalıştırılabilir komut olarak yazdırılmaz: rapor çakışmayı ve o paketleri adlandırır ve çakışma elle çözüldükten sonra çalıştırılacak komutları gösterir (JSON'da: `blocked`).
- Registry verisi okunamıyorsa (veya zincir genel registry'den olmayan, hiç sorgulanmayan bir paketten geçiyorsa), plan o bağımlılık için tahmin yürütmek yerine tahmini olmadığını söyler.

Maliyet: rapor için indirilen registry belgeleri yeniden kullanılır; bu yüzden plan genellikle ek registry isteği gerektirmez (tarama başına en çok 150; 8'er 8'er, önce production bağımlılıklarına ve en kötü advisory'lere harcanır; sınır planı kısa keserse bir uyarı kaç paketin henüz sorgulanmadığını söyler; bunlar diğerleri gibi 6 saat önbelleğe alınır, dolayısıyla sınıra ulaşıldığında ikinci çalıştırma ilkinin kaldığı yerden devam eder) ve iki üç ek OSV toplu sorgusu (artı henüz görülmemiş advisory'lerin ayrıntıları). `--no-plan` bunu atlar. JSON'da `plan`, `estimated: true` ile doğrudan bağımlılık başına bir girdi tutar; `suggestedOverrides` planın gereksiz kıldıkları dahil her güvenli override'ı listelemeye devam eder.

### Önerilen override'lar hakkında

Bir npm override'ı bir paketin **her** kurulu kopyasını, `--no-dev` ne derse desin production ve dev bağımlılıklarda birlikte değiştirir. patchpath yalnızca lockfile'daki tüm kopyalar için güvenliyse bir tane önerir:

- paket projenin kendisi tarafından, hiçbir bölümde ve hiçbir spec ile (git ve file olanlar dahil) bildirilmemiştir (npm bu tür override'ları `EOVERRIDE` ile reddeder; bunun yerine bağımlılığın kendisini yükseltin);
- her kopya genel registry'den gelir, önerilen sürümden yeni değildir (sürüm düşürme yok) ve aynı kırıcı hattadır (aynı major; `0.x`'te aynı minor; `0.0.x`'te aynı yama);
- önerilen sürüm (her "fixed in" sürümü gibi) OSV'ye karşı denetlenmiştir ve kendi advisory'si yoktur. Varsa bir sonraki düzeltilmiş sürüm denenir; hiçbiri kalmazsa override önerilmez ve rapor bunu söyler;
- gömülü kopyalar (`inBundle`) dışarıda bırakılır: npm onları override edemez. Onlar, yükseltilecek paketle birlikte "Bundled copies" altında listelenir.

Kalan riskler: bir override bir paketi ebeveyninin bildirdiği aralığın dışına taşıyabilir (örneğin `~6.5.2` -> `6.16.0`); semver bunun uyumlu olduğunu söyler, ama paketler semver'i her zaman izlemez. Bloğu gözden geçirin, `npm install` ve testlerinizi çalıştırın.

## Lockfile'lar

| Dosya | Rapor | Yükseltme planı, komutlar, `overrides` |
|---|---|---|
| `package-lock.json`, `npm-shrinkwrap.json` (v1, v2, v3) | evet | evet |
| `yarn.lock` (yarn v1 / classic) | evet | hayır: rapor "upgrade plan is not available for yarn/pnpm lockfiles yet" der (JSON'da `planUnavailable`) |
| `pnpm-lock.yaml` (`lockfileVersion: '9.0'`, pnpm 9 ve 10) | evet | hayır (aynı not) |

yarn ve pnpm için raporun geri kalanı eksiksizdir: düzeltilmiş sürümleriyle zafiyetler, deprecation'lar, gerilik, `via`, doğrudan/dev, `--no-dev`, `--fail-on` ve çıkış kodları. Bunlar için npm komutu veya `overrides` bloğu yazdırılmaz. yarn v2+ (berry) ve v9'dan eski pnpm lockfile'ları hata ile reddedilir. pnpm workspace'leri (`importers`), alias'lar (`npm:`) ve peer varyantları (`react-dom@18.2.0(react@18.2.0)`, bir kez raporlanır) okunur; pnpm v9'da dev bayrağı yoktur, bu yüzden yalnızca dev olan paketler `devDependencies`'ten erişilebilirliğe göre hesaplanır. yarn v1 lockfile'ında ağaç yoktur; bu yüzden doğrudan ve yalnızca dev olan paketler `package.json`'dan (ve `dir` veya `dir/*` olarak listelenen workspace'lerin `package.json`'larından) gelir; `package.json` yoksa her paket geçişli production kodu olarak raporlanır ve bir uyarı bunu söyler.

Bir klasörde birden çok lockfile varsa, package.json'daki `packageManager` ile eşleşeni (`npm@`, `pnpm@`, `yarn@1.`) okunur; yoksa `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock` sırasındaki ilki okunur. Bir uyarı okunmayanları adlandırır; başka birini taramak için lockfile yolunu verin.

## Seçenekler

| Seçenek | Etki |
|---|---|
| `--json` | Tam raporu JSON olarak verir |
| `--no-dev` | Yalnızca geliştirme için kurulan paketleri atlar (`npm install --omit=dev`'in dışarıda bıraktıkları) |
| `--no-cache` | Yerel önbelleği kullanmaz |
| `--no-plan` | Yükseltme planını atlar (`ScanOptions.plan: false` de aynı) |
| `--fail-on <level>` | Bir zafiyet `low`, `moderate`, `high` veya `critical` düzeyinde ya da üstündeyse 1 koduyla çıkar. Bilinmeyen ciddiyet moderate sayılır. |
| `--registry <url>` | `resolved` URL'si bu önekle başlayan paketler genel registry paketi sayılır ve denetlenir. registry.npmjs.org'un bir ayna veya proxy'si için kullanın (Artifactory, Nexus, Verdaccio). Tekrarlanabilir. |
| `--include-pinned-lag` | package.json'da tam sürüme sabitlenmiş (`"pyodide": "0.27.2"`, `^`/`~` yok) ve bir ana sürüm geride olan doğrudan bağımlılıklar için de uyarır. Sabitlemeler genellikle bilinçli olduğundan varsayılan olarak gizlidir; zafiyetleri her zaman raporlanır (ayrıca `ScanOptions.includePinnedLag`). |
| `--assume-public` | `resolved` URL'si olmayan lockfile girdilerini genel registry paketi sayar (npm'in `omit-lockfile-registry-resolved` ayarıyla yazılmış lockfile'lar için). Bir registry paketinin npm 6 gömülü veya `"resolved": false` çocukları için, ne de düz `http://` registry.npmjs.org URL'leri için gerekmez: onlar zaten denetlenir. |
| `--allow-unchecked` | `--fail-on` ile, bazı paketler denetlenemedi diye başarısız olmaz (çıkış 3 vermez). |

Çıkış kodları:

| Kod | Anlamı |
|---|---|
| `0` | `--fail-on` düzeyinde veya üstünde zafiyet yok (veya `--fail-on` verilmedi) |
| `1` | `--fail-on` düzeyinde veya üstünde bir zafiyet var |
| `2` | Hata: kötü seçenek, okunamayan lockfile, ağ hatası |
| `3` | `--fail-on` verildi ve eşiğe ulaşılmadı, ama bazı paketler denetlenmedi (bkz. Gizlilik). Temiz bir sonuç yanıltıcı olurdu, bu yüzden CI başarısız olur. `--registry` / `--assume-public` ile giderin veya `--allow-unchecked` ile boşluğu kabul edin. |

## Gizlilik

Yalnızca lockfile `resolved` URL'si `https://registry.npmjs.org/` veya `https://registry.yarnpkg.com/` ile başlayan (veya eski npm sürümlerinin aynı sunucular için yazdığı düz `http://` biçimi) paketlerin **adları ve sürümleri** `api.osv.dev` ve `registry.npmjs.org`'a gönderilir. Geri kalan her şey denetlenmez ve adı hiçbir yere gitmez:

- başka registry'lerden, git'ten, tarball URL'lerinden veya yerel dosyalardan gelen paketler;
- **`resolved` URL'si olmayan** paketler: kaynakları bilinmediği için özel olabilirler. İstisna, başka bir paketin gömdüğü bağımlılıklardır (`inBundle`, v1 lockfile'larda `bundled`): bunların kendi URL'si yoktur ve kendilerini gömen pakete uyarlar. Kendi projenizin (kök veya bir workspace) gömdüğü bir paket, diğerleri gibi kendi `resolved` URL'sine göre değerlendirilir. Bir registry paketinin isteğe bağlı veya gömülü çocukları için `"resolved": false` yazan npm 6 lockfile'ları için de aynısı geçerlidir (fsevents 1.x ağacı): bunlar yalnızca ebeveyni genel registry'den çözümlenmişse denetlenir.

`yarn.lock` (v1) için aynı kural her girdinin `resolved` URL'sine uygulanır ve iki denetim daha geçilmelidir: girdinin başlığındaki her spec bir registry aralığı veya etiketi olmalıdır (git, URL, `file:`, `link:` veya GitHub kısaltması olmamalı) ve URL, girdinin kendi paket adı için o registry'nin tarball yolu olmalıdır (`<name>/-/...`; yani başka bir ad altında listelenen genel bir tarball denetlenmez). Bir alias (`"x@npm:lodash@^4"`) yalnızca `lodash` olarak aranır.

`pnpm-lock.yaml` (v9) için pnpm, bir `tarball` URL'sini yalnızca kurulum sırasında yapılandırılmış registry'nin standart URL'si değilse yazar; yalnızca `integrity` olan bir girdi o registry'den gelmiştir, ama lockfile bunun hangisi olduğunu söylemez (özel olabilir veya bir scope registry'si olabilir). Bu yüzden böyle girdiler `resolved` olmayan npm girdileri gibi ele alınır: denetlenmez, `--assume-public` verilmedikçe (o zaman adları gönderilir). `tarball` URL'si olan bir girdi, URL o paket için genel registry'nin (veya bir `--registry` önekinin) tarball yolu ise denetlenir; dizinler, git, `file:`, `link:` ve workspace paketleri asla denetlenmez. pnpm'de `--registry` yalnızca `integrity` olan girdileri açamaz (eşleşecek URL yoktur), yalnızca `--assume-public` açabilir.

Denetlenmeyen paketler raporda sayılır (`summary.external`) ve onları nasıl denetleyeceğinizi söyleyen bir uyarıda listelenir. İki isteğe bağlı seçenek nelerin gönderildiğini genişletir:

- `--registry <url>`, o önekten çözümlenen paketlerin adlarını gönderir. Yalnızca genel registry'nin bir aynası için kullanın. Aynı URL özel paketleri de sunuyorsa (ikisini birleştiren bir "sanal" depo), onların adları da gönderilir.
- `--assume-public`, `resolved` URL'si olmayan tüm paketlerin adlarını gönderir. Yalnızca bunların genel registry paketleri olduğunu biliyorsanız kullanın.

Yükseltme planı aynı kuralı izler. `registry.npmjs.org`'a yalnızca zafiyetli bir zincir üzerindeki paketleri sorar; bunların hepsi zaten denetlenen kurulu paketlerdir (genellikle rapor için indirilmiş belgeler yeniden kullanılır) ve `api.osv.dev`'e bu paketlerin adlarını, tahmin ettiği aday sürümlerle gönderir. Denetlenmeyen bir paketten geçen zincir izlenmez ve o paket asla istenmez.

"Yalnızca kurulu paketler" kuralının tek istisnası peer ERESOLVE öngörüsüdür (npm lockfile'ları). Planlayıcı, güvenli (kırıcı olmayan) bir yükseltmenin güvenli `npm install` adımına girip giremeyeceğine karar vermek için, genel ve denetlenen bir paketin yeni sürümünün bildirdiği ama **kurulu olmayan** bir peer'in registry belgesini de `registry.npmjs.org`'dan ister (npm bu peer'leri de yükler ve ERESOLVE ile durabilir). Ad, lockfile'ınızdan değil o genel paketin kendi registry metadata'sından gelir ve yalnızca ad gider: kurulu olmayan her peer için bir istek (onların peer'leri de sayılır); 150 plan isteğinin en çok 30'u, sınır işi keserse bir uyarı bunu söyler. Lockfile'ınızda denetlenmeyen bir kaynaktan (özel registry, git, dosya) gelen bir ad asla istenmez ve denetlenmeyen paketler hakkında hiç sorulmaz. Bu peer'ler için `api.osv.dev`'e hiçbir şey gönderilmez; `--no-plan` hepsini kapatır.

Kaynak kodunuz ve dosya yollarınız makinenizden asla çıkmaz. Rapor taranan lockfile yolunu (metin çıktısının ilk satırı; `--json`'da `root` ve `lockfile`) geçerli dizine göreli gösterir; dizin dışında ama ev dizininiz altındaysa `~/...` biçiminde gösterir, yani kullanıcı adınız içinde olmaz. Yalnızca ikisinin de dışındaki bir proje tam mutlak yolla gösterilir (içinde kullanıcı adı olabilir); bir raporu herkese açık bir yere yapıştırmadan önce o satırı kontrol edin. OSV ve registry yanıtları (yalnızca herkese açık veri) yerel bir dizinde (`%LOCALAPPDATA%\patchpath`, yoksa `$XDG_CACHE_HOME/patchpath` veya `~/.cache/patchpath`) birkaç saat önbelleğe alınır; `--no-cache` onu ne okur ne yazar. Bkz. [SECURITY.md](SECURITY.md).

Lockfile'dan (paket adları, sürümler, `via` zinciri), advisory'lerden ve registry'den gelen metinler okunurken ve yazdırılmadan önce yeniden temizlenir: kontrol karakterleri, görünmez ve çift yönlü biçimlendirme karakterleri ve Unicode etiket karakterleri değiştirilir, boşluklar tek satıra indirilir ve uzunluk sınırlanır (tam liste SECURITY.md'de). Yine de JSON'u başka bir programa veya bir yapay zekâ ajanına veriyorsanız bunlara güvenilmeyen veri gözüyle bakın.

## Sınırlar

- npm lockfile'ları; yarn v1 ve pnpm v9 ise yükseltme planı olmadan. yarn berry, v9'dan eski pnpm, bun, PyPI ve Cargo henüz desteklenmiyor.
- pnpm: lockfile girdisinde yalnızca `integrity` olan (`tarball` olmayan) paketler, `--assume-public` verilmedikçe denetlenmez (bkz. Gizlilik); bu yüzden onsuz bir pnpm taraması genellikle çok az şeyi denetler.
- Temiz bir rapor garanti değildir: patchpath yalnızca OSV'nin bildiğini ve yalnızca denetlediği paketleri bilir.
- Önerilen sürümler advisory verisinden gelir; kodunuzla uyumluluğu denetlemezler.
- Kötü amaçlı işaretlenmiş bir paket (`MAL-` advisory'si) öyle raporlanır, ama onun için önerilecek bir yükseltme yoktur; kaldırın.
- Yükseltme planı registry üst verisinden yapılan bir tahmindir, npm resolver çalıştırması değildir ([Yükseltme planı nasıl çalışır](#yükseltme-planı-nasıl-çalışır)).

## Fikirler (taahhüt değil)

- Pull request'ler için fark (diff) modu ve bir GitHub Action
- Yapay zekâ ajanlarının "bu depo sağlıklı mı?" diye sorabilmesi için MCP sunucusu
- Çalışma zamanı ve Docker end-of-life denetimleri (endoflife.date)
- Lisans denetimleri

## Geliştirme

```
npm install
npm test        # önce dist/ derlenir: CLI testleri gerçek dist/cli.js'i çalıştırır
npm run build
node dist/cli.js <path>
```

Node 22 veya üzeri gerekir. `npm run typecheck` tip denetleyicisini çalıştırır.

## Katkı

Issue ve pull request'ler memnuniyetle karşılanır. Bir değişiklik göndermeden önce `npm run typecheck` ve `npm test` çalıştırın, davranış değişiklikleri için test ekleyin (testler sahte ağ yanıtları kullanır, gerçek OSV'ye veya registry'ye asla istek atmaz) ve [CHANGELOG.md](CHANGELOG.md)'de "Unreleased" altına bir satır ekleyin. Sıfır çalışma zamanı bağımlılığı kuralını koruyun (`semver` derleme sırasında gömülür). Güvenlik sorunlarını özel olarak bildirin, bkz. [SECURITY.md](SECURITY.md).

## Claude'un yardımıyla geliştirildi

patchpath, Anthropic'in yapay zekâ kodlama asistanı [Claude](https://claude.com/claude-code) (Claude Code) yardımıyla geliştirildi.

## Lisans

MIT
