# Hangi bağımlılığı yükseltmeliyim? 34 gerçek lockfile üzerinde bir npm yükseltme planlayıcısının ölçümü

*Bu yazı İngilizce [ARTICLE.md](ARTICLE.md) ile aynı içeriği taşır; ikisi arasında fark görürseniz İngilizce sürüm esastır.*

*Sayılar, Ekim 2026'da patchpath 0.0.1 (commit 9a353a5) üzerinde yapılmış tek bir benchmark çalışmasından gelir. O günden beri yayınlanan 0.1.0 ve 0.1.1 sürümleri yalnızca rapor başlığını değiştirdi (bkz. Dürüst sınırlar) ve paketten source map'leri çıkardı; tarama ve planlama kodu aynı.*

## Sorun

`npm audit` çalıştırırsınız ve üç seviye aşağıdaki bir paketin bilinen bir advisory'si olduğunu söyler. Bu kısım işe yarar. Söylemediği, asıl yapmanız gereken şeydir: *kendi* doğrudan bağımlılıklarınızdan hangisini, hangi sürüme ve hangi komutla yükselteceksiniz. Zinciri `npm ls` ile elle izleyebilirsiniz, ya da `npm audit fix` çalıştırabilirsiniz; ki o da çoğu zaman işe yarar, ta ki bir ERESOLVE peer-dependency çakışmasında durup hiçbir şeyi düzeltmeyene kadar.

Pratik soruyu yanıtlayan bir rapor istedim: "`express`'i 4.22.3'e, `socket.io`'yu 4.8.0'a yükselt, şu tek komutu çalıştır, kırıcı yükseltme için şu ayrı komutu çalıştır." Bu yüzden küçük bir CLI olan patchpath'i yazdım ve beklediğimden fazla zamanı onu ölçmeye harcadım. Bu yazı ne yaptığını, nasıl test ettiğimi ve nerede yetersiz kaldığını anlatıyor.

## patchpath ne yapar, ne yapmaz

Bir npm projesi için patchpath `package-lock.json` dosyasını okur ve şunları yazdırır:

- bilinen her zafiyet, onu içeri çeken doğrudan bağımlılıktan başlayan zincirle (`via`);
- doğrudan bağımlılığa göre gruplanmış bir **yükseltme planı**: hedef sürüm, kaç advisory'yi kapatacağı tahmini ve kırıcı bir sınırı geçip geçmediği;
- sabit bir sırayla çalıştırmaya hazır komutlar: önce kırıcı olmayan tek bir adım, sonra kırıcı veya peer çakışması olan her yükseltme kendi komutu olarak; böylece reddedilen tek bir ana sürüm güvenli düzeltmeleri engellemez;
- kullanımdan kaldırılmış paketler ve bir ana sürüm geride kalan doğrudan bağımlılıklar.

Yapmadıkları da en az bunlar kadar önemli:

- **Yeni bir zafiyet veritabanı değildir.** Advisory'ler, diğerlerinin yanında GitHub advisory veritabanını da toplayan [OSV](https://osv.dev)'den gelir. Yani tespit özünde `npm audit`'in zaten verdiğidir; fark gruplama ve plandadır.
- **Plan bir tahmindir.** Aday sürümlerden başlayarak her zafiyetli zinciri registry üst verisiyle yürüyerek kurulur. Bir npm resolver çalıştırması değildir. Uygulayın, sonra yeniden tarayın.
- **Kaynak kodunuzu okumaz** ve bir yükseltmenin onunla uyumlu olduğunu denetlemez.
- **Bağımlılıklarınızın kodunu yamalamaz.** patch-package'ın aksine yalnızca sürüm ve komut önerir.
- **Plan yalnızca npm içindir.** `yarn.lock` (v1) ve `pnpm-lock.yaml` (v9) için rapor (zafiyetler, düzeltilmiş sürümler, zincirler, deprecation'lar) alırsınız, ama henüz plan ve komut yok.

## Nasıl ölçtüm

Başkasının yeniden üretebileceği sayılar istedim; bu yüzden ölçüm, ortak kod içermeyen ayrı bir kit. Depoda [`benchmark/`](https://github.com/serhat-10/patchpath/tree/main/benchmark) altında duruyor.

**Korpus.** 34 herkese açık GitHub projesi: 22'si `package-lock.json` ile (lockfile sürüm 1, 2 ve 3), 6'sı yarn v1, 6'sı pnpm 9 lockfile'ıyla. Her biri tam bir commit SHA'sına sabitlenmiş ve indirilen her dosya kayıtlı bir SHA-256 ile denetleniyor. Listede NodeGoat, TypeScript ve VS Code depoları, Chart.js, socket.io, parse-server, Nightscout, directus, npm CLI, vite, Vue core ve diğerleri var.

**Birim.** Bir birim, bir paketin `name@version` değeri artı bir OSV advisory kimliğidir. Paketleri saymak farklı sayılar verir; yalnızca advisory düzeyindeki birimi raporluyorum.

**Referans.** Kendi lockfile ayrıştırıcıları olan bağımsız bir betik (npm v1/v2/v3, yarn v1, pnpm 9), bulduğu her `name@version` için OSV'yi doğrudan sorgular. patchpath, herkese açık olduğundan emin olamadığı paketleri bilerek atladığı için (aşağıda daha fazlası var), karşılaştırma kapsamları eşleşen üç varyantta yapılır: `default`, `nodev` (yalnızca npm, `--no-dev`) ve `assume-public` (`resolved` URL'si olmayan girdiler herkese açık sayılır).

**npm audit.** 22 npm projesi için ayrıca, farklı bir advisory kaynağı ve kimlik düzeni kullanan `npm audit` ile de karşılaştırdım.

**Planlar.** 10 npm projesi için planları, her projenin ayrı kopyalarında `npm install --package-lock-only --ignore-scripts` ile uyguladım, sonra `npm audit`'in hâlâ ne raporladığını saydım. Bunu, başka bir kopyada çalıştırılan `npm audit fix` (`--force` olmadan) ile karşılaştırdım.

## Sonuçlar

### Tespit

| varyant | proje | patchpath birimi | kapsamdaki referans birimi | yanlış pozitif | yanlış negatif | kesinlik | duyarlılık |
|---|---|---|---|---|---|---|---|
| default | 34 | 6669 | 6748 | 0 | 79 | 100,0% | 98,8% |
| nodev (npm) | 22 | 1738 | 1825 | 0 | 87 | 100,0% | 95,2% |
| assume-public | 34 | 8807 | 8807 | 0 | 0 | 100,0% | 100,0% |

"Kapsamdaki referans birimi", referansın her varyantın kurallarına göre patchpath'ten kontrol etmesini beklediği birimlerdir. Her satırda patchpath'in birimleri artı yanlış negatifler kadardır; yani patchpath'in raporladığı hiçbir şey referansın dışında değil. Kitin ilk sürümü patchpath'in bilerek ele aldığı iki durumu kaçırmıştı ve bu yüzden patchpath 202 fazla birim raporlamış gibi görünüyordu: kendi URL'si olmayıp onları paketleyen pakete bağlı olan bundled paketler (142 birim, çoğu NodeGoat) ve `"resolved": false` yazan eski npm lockfile'larında herkese açık bir paketin opsiyonel çocukları (59 birim). Geri kalanı Chart.js'teki düz `http` bir registry URL'siydi. Kaçırılanlar sınırlar bölümünde açıklanıyor.

22 npm projesinde `npm audit` ile karşılaştırma (`--assume-public` ile, birim paket artı GHSA kimliği): patchpath 3840, npm audit 3827, ortak 3826. 22 projenin 20'si birebir eşleşiyor. Farklar: yalnızca patchpath'in raporladığı 14 birim (bir projede 13, bir başkasında 1) ve yalnızca npm audit'in raporladığı 1 birim. Nedenin advisory veritabanları arasındaki bir fark olduğunu varsayıyorum, ama doğrulamadım.

### Yükseltme planları

10 proje, npm korpusundan 49 ile 214 arasında açık advisory'si olan, planında workspace (`-w`) komutu bulunmayan ve taraması 20 saniyenin altında süren projeler olarak seçildi. Aşağıdaki sayılar `npm audit --package-lock-only --json` çıktısındaki tekil paket-artı-advisory çiftleridir.

| proje | önce | patchpath kırıcı olmayan adım sonrası | `npm audit fix` sonrası | patchpath adımı + ayrı komutlar sonrası |
|---|---|---|---|---|
| typescript | 49 | 5 | 13 | 4 |
| socketio | 77 | 23 | 21 | 16 |
| gatsby-blog | 130 | 25 | 28 | (ayrı komut yok) |
| nextjs-blog | 132 | 46 | 50 | 37 |
| vscode | 150 | 73 | 87 | 29 |
| bookshelf | 179 | 86 | 179 | 84 |
| parse-server | 182 | 89 | 182 | 84 |
| nodegoat | 197 | 162 | 197 | 134 |
| chartjs | 210 | 66 | 71 | 66 |
| nightscout | 214 | 120 | 115 | 108 |
| **toplam** | **1520** | **695** | **943** | **587** |

Yalnızca kırıcı olmayan adımı `npm audit fix` ile karşılaştırırsak: patchpath 10 projenin 8'inde daha az, 2'sinde daha fazla açık advisory bıraktı (socketio: 21'e karşılık 23; nightscout: 115'e karşılık 120). bookshelf, parse-server ve nodegoat'ta `npm audit fix` hiçbir şey kapatmadı; gatsby-blog, bookshelf ve parse-server'da `npm audit fix` kaynaklı ERESOLVE uyarıları veya hataları gördüm.

Aynı çalışmadan başka gözlemler:

- **Tahmin temkinli.** 10 projede planlar 1162 advisory'yi kapatacağını iddia etti; uyguladıktan sonra patchpath ile yeniden tarama 1386'sının kapandığını gösterdi ve her projede gerçek sayı iddiadan az değildi. Bu sayım patchpath'in kendi advisory birimini kullanır; bu yüzden yukarıdaki npm audit sütunlarıyla doğrudan karşılaştırılamaz.
- **Ayrı komutlar çoğunlukla çalışıyor.** 68 ayrı (kırıcı) komuttan 67'si 0 koduyla çıktı; biri ERESOLVE ile başarısız oldu (nextjs-blog'da `eslint@10.13.0`).
- **Çökme yok.** 90 tarama (34 default, 22 nodev, 34 assume-public), her biri JSON ve metin çıktısıyla: hepsi 0 koduyla çıktı, tüm JSON'lar geçerliydi, stderr boştu.
- **Hız.** Default tarama için proje başına medyan 11,6 saniye; soğuk önbellek, ardışık, en fazla 30,5 saniye. pnpm default taramaları kötü bir nedenle bir saniyenin altında bitiyor: `--assume-public` olmadan neredeyse hiçbir şeyi kontrol etmiyorlar (aşağıya bakın).
- **Ağ.** Taramalar sırasında giden her isteği kaydettim. Hepsi `registry.npmjs.org` ve `api.osv.dev`'e gitti; başka host yoktu.

## Dürüst sınırlar

**79 yanlış negatif.** Hepsi (nest 19, ngx-admin 14, directus 46) aynı nedene dayanıyor ve her birini bir betikle denetledim: aynı `name@version`, lockfile'da hem `resolved` URL'siyle hem de URL'siz geçiyor. patchpath ikisini birleştiriyor, URL'siz girdi kazanıyor ve sürüm "kontrol edilmedi" sayılıyor. Bu tasarım gereği fail-closed (URL'si olmayan bir paket özel olabilir, bu yüzden adı hiçbir yere gönderilmez) ve sessiz değil: adlar "N paket kontrol edilmedi" uyarısında görünür. `--assume-public` ile sayı 0'a iner. Yine de bir kaçırma. `resolved` kopyanın diğerine kefil olmasına izin vermeyi düşündüm ve vazgeçtim: bu, duyarlılık kazanmak için bir gizlilik kuralını gevşetmek olurdu ve `--assume-public`, lockfile'ının herkese açık olduğunu bilenler için boşluğu zaten kapatıyor.

**`nodev`'deki ek kaçırmalar.** 87'nin 60'ı yukarıdakiyle aynı neden. Kalan 27'si Nightscout'ta: patchpath'in erişilebilirlik denetimi bazı girdileri production dışı sayıyor, referans ise production sayıyor. Bence orada patchpath haklı, ama yalnızca iki paketi elle denetledim; bu yüzden hepsini kaçırma olarak saydım.

**Yanıltıcı bir başlık.** directus'ta rapor "48 known vulnerabilities in 18 packages" diye başlıyordu, oysa 3141 paketin 2849'u (%91) kontrol edilmemişti. Bunu söyleyen uyarı uzun bir raporun sonundaydı. nest ve ngx-admin daha küçük ölçekte aynı örüntüyü gösteriyor. Bu bir kullanım sorunuydu ve 0.1.0'dan beri düzeltildi: zafiyetler listelenip bazı paketler kontrol edilmediğinde, sayının altındaki satır bunu söylüyor; örneğin "2849 of 3141 packages (91%) were not checked, so the list may be incomplete". (`--assume-public` olmadan pnpm taramaları sıfır raporlamak yerine zaten "Nothing was checked ... This is not a clean result" diyor.)

**10 projenin 2'sinde `npm audit fix`'ten kötü.** socketio ve nightscout'ta kırıcı olmayan adım, `npm audit fix`'ten daha fazla açık bıraktı. Plan bir tahmin ve npm'in resolver'ı bazen daha iyisini yapıyor.

**Korpus.** Elle seçildi, çoğunlukla eski (commit'lerin çoğu 2019 ile 2024 arası) ve ön yüz ağırlıklı. npm'in bir örneklemi değil ve 34 proje küçük bir sayı.

**Referans aynı veri kaynağını paylaşıyor.** Tespit referansı, patchpath'in kullandığı OSV'yi sorguluyor. Uyum, lockfile okuma ve eşleştirmenin tutarlı olduğunu gösterir; ikisinin de eksiksiz veya doğru olduğunu göstermez.

**Ölçemediklerim.** Mailspring planı değerlendirilemedi: bir git bağımlılığı var, test düzenim yalnızca yukarıdaki iki host'a izin veriyordu ve npm ERESOLVE ile durdu; bu yüzden onu Nightscout ile değiştirdim. Workspace (`-w`) komutları gerektiren planlar (bitwarden, npm CLI, directus) ve mattermost planı da ölçülmedi, `npm audit fix --force` de öyle.

**`npm audit` hareket eder.** Advisory kümesi zamanla değişir; bu yüzden npm audit sütunları aynı lockfile'lardan daha sonra tam olarak yeniden üretilemez. OSV yanıtları da değişir; kit, her referans sonucuyla birlikte sorgu tarihini saklıyor.

## Deneyin

Node 22 veya üzeriyle:

```
npx patchpath ./my-app
```

Kaynak https://github.com/serhat-10/patchpath adresinde (MIT).

Makine tarafından okunabilir çıktı için `--json`, yalnızca geliştirme paketlerini atlamak için `--no-dev`, CI için `--fail-on high` ekleyin.

**Gizlilik.** Yalnızca lockfile'ın herkese açık npm registry'sinden geldiğini söylediği paketlerin adları ve sürümleri `api.osv.dev` ve `registry.npmjs.org`'a gönderilir. Başka registry'lerden, git'ten, tarball URL'lerinden veya yerel dosyalardan gelen paketler ve `resolved` URL'si olmayan paketler asla gönderilmez; kontrol edilmemiş sayılır ve bir uyarıda listelenir. `--assume-public` ve `--registry` bunu bilerek genişletir. Kaynak kodunuz ve dosya yollarınız makinenizde kalır.

**Sayıları yeniden üretin.** `benchmark/` içindeki kit Node 22 ister, `npm install` gerektirmez; `node run-all.mjs` her şeyi sırayla yapar. Sabitlenmiş korpusu indirir (hash'i farklı olan dosyayı reddeder), OSV referansını kurar, patchpath'i çalıştırır, sonuçları karşılaştırır ve 10 plan projesi için planları ayrı kopyalarda `npm audit fix`'in yanında uygular. Plan adımı npm ister ve biraz sürer: TypeScript projesi makinemde yaklaşık üç dakika, yani on projenin tamamı için 30 ila 40 dakika düşünün (bir tahmin, tam çalışmayı zamanlamadım). `--skip-plan` yalnızca tespitle sınırlar. `results/round6/`, bu yazıdaki sayıların, ölçüldükleri Node ve npm sürümleriyle birlikte bir anlık görüntüsünü tutar; `ADD-A-PROJECT.md` korpusa nasıl proje ekleneceğini anlatır.

## Geri bildirim

Kendi projenizde denerseniz ve plan yanlışsa ya da buradaki bir sayı tutmuyorsa, lütfen https://github.com/serhat-10/patchpath/issues adresinde bir issue açın; duymak isterim.
