"""Pools for pseudonyms, and word lists the name stages consult.

Any pool entry that collides with a real name token in the data is dropped at
runtime, so a fake can never be mistaken for a real person. Pools are sized so
~1000 people and ~200 streets get distinct fakes without much reuse."""

FIRST = """
Aaron Abby Abel Ada Adele Adina Adrian Aidan Ainsley Aisha Alana Alba Alden Aldo Alma Alvin Amara Ambrose
Amos Anika Ansel Anya Arden Ari Arlo Arwen Asa Asha Astrid Atticus Aubrey Augustin Avery Axel Bastian
Beatrix Bellamy Bennett Bianca Blaine Blythe Bodhi Bram Brielle Bruno Cade Callum Calla Camila Carmen
Casimir Casper Cassius Cecil Celeste Cerys Cleo Clement Colette Conrad Cora Corin Cosmo Cyrus Dahlia
Dalia Damon Dante Daphne Darius Delia Delphine Desmond Dina Dorian Dulce Eamon Edie Edison Eldon Elio
Eloise Elsa Elspeth Emeric Eadric Emmett Enzo Esme Esther Evander Ezra Fabian Farah Felix Fenna Fern
Fiona Flint Floyd Freya Gage Galen Gemma Gideon Gilda Gisela Greer Gwen Hale Hamish Hana Harlan Hattie
Hollis Honora Hugo Ida Ignatius Ilse Imani Indira Ingrid Ira Isla Ismay Ivo Jada Jalen Jasper Jolene
Joss Jude Juniper Kaia Keane Kenji Kiara Kirby Knox Lacey Lark Leif Lena Lennox Leona Levi Lila Linus
Liesel Lorna Lowell Lucan Luna Lyra Mabel Magnus Maia Malik Marcel Margo Marlo Mateo Maude Mavis Mila
Milo Mira Moira Wenna Nell Nico Nils Nina Noor Nora Oakley Odette Odin Olin Omar Opal Orla Orson Otto
Paloma Pax Perrin Petra Pia Quentin Quinn Raina Ramon Reese Tavi Rhea Rocco Rohan Roman Rosa Rowan Rufus
Saffi Sage Salma Santos Selah Seren Silas Soren Stellan Suri Sylvie Tamsin Tariq Tate Thea Theo Tobias
Tova Tristan Uma Una Valen Vera Vida Viggo Willa Wren Xiomara Yara Yusuf Zadie Zane Zara Zeke Zola
Adaeze Afton Agnes Ailsa Alaric Alessia Alistair Amadeo Anais Anouk Anselm Araceli Aurelio Auden Azalea
Babette Barnaby Basil Benedetta Bettina Birgit Booker Briar Bryony Caius Calder Calista Camden Carys
Cassia Cedric Ceridwen Clio Cordelia Corwin Crispin Dagny Damaris Darcy Delano Demetria Dermot Dorothea
Dov Ebba Edmund Elif Elodie Emrys Ennis Ephraim Ersa Estelle Eudora Evadne Ezio Faustina Felicity
Fenton Fintan Flora Florian Gaspard Genevieve Gerrit Gianna Giles Gunnar Gwyneth Halvard Hamza Harriet
Hedda Henrietta Hester Hilde Horatio Idris Ilaria Imogen Isadora Ivor Jael Jarrah Jessamy Joaquin
Jocasta Jovan Junia Kasimir Katriel Keturah Kioko Lavinia Leander Leocadia Linnea Lisandro Lorcan
Lucasta Ludovic Lysander Mafalda Malachy Marisol Matthias Maxine Meredith Mireille Montague Morwenna
Nadira Naomi Nerys Niamh Ninian Noemi Octavia Odalys Olwen Orlaith Osric Ottilie Pascal Peregrine
Philippa Piers Primrose Prosper Quilla Radomir Rafferty Ramona Reuben Rosalind Rosamund Ruadh Sabine
Saoirse Sebastiano Seraphina Severin Sidonie Solveig Sorcha Stellina Sunniva Tabitha Talulla Tancredi
Teodora Thaddeus Thora Tiberius Ulrika Ursula Valentina Vesper Viveka Wilhelmina Winifred Wolfram
Xanthe Ysolde Zephyr Zinnia
""".split()

LAST = """
Abernathy Ainsley Albrecht Aldana Alvarado Ambleside Ashdown Avalos Babcock Ballard Barlowe Beaumont
Bellweather Birch Blackwood Bolton Bramwell Brennan Brightwater Caldwell Calloway Carrow Castellan
Chadwick Corbin Cordova Crane Crowley Dalgado Danforth Delacroix Devereux Dorsey Drummond Easton
Ellery Emberly Eskew Fairbanks Falconer Farrow Fenwick Finch Fitzgerald Galloway Garnett Gentry
Goodwin Granger Greaves Hadley Halvorsen Harlow Hartwell Haverford Holloway Huxley Ingram Irving
Iverson Jardine Kensington Kessler Kingsley Lachance Langley Larkin Lockwood Lorne Lowery Lyndon
Macready Maddox Marchetti Marlowe Mercer Merriweather Montclair Morrow Nakamura Navarro Nettleton
Norcross Oakes Okafor Oldham Orwell Pemberton Pendleton Penrose Prescott Quimby Radcliffe Rainier
Ramsey Redfield Rhodes Rockwell Rosales Ruiz Salazar Saltonstall Sandoval Sato Sawyer Sedgwick Selby
Sheffield Sinclair Stanton Sterling Stroud Sutherland Talbot Tatum Thackeray Thorne Townsend Trevino
Underhill Valdez Vance Vasquez Voss Wakefield Waverly Westbrook Whitaker Whitlock Winslow Wolcott
Yardley Yates Yoshida Zamora Zeller Achterberg Adeyemi Akintola Albescu Allardyce Amberley Anstruther
Arbuthnot Ardmore Ashcombe Atherton Aubertin Axelrod Balfour Bancroft Barrowman Bascombe Battersby
Beauchamp Belcourt Benbow Beresford Blakemore Blanchet Bolingbroke Bonaventure Boscawen Brackenbury
Bradwell Brassard Brightman Brookhouse Bucknell Burgoyne Cadogan Calderwood Cantrell Carmody Castellano
Chalmers Charbonneau Chesterfield Clairmont Coldwell Colquhoun Corcoran Courtenay Cravenhurst Crisp
Culpepper Dalrymple Darnell Dashwood Delahaye Delvecchio Desrosiers Dunmore Eckhart Edevane Ellesmere
Elphinstone Everleigh Faircloth Falkenrath Featherstone Fennimore Ferrand Fiorentino Fortescue
Foxworth Gainsborough Galbraith Garroway Gilchrist Glanville Glendower Grantham Greenhalgh Grimaldi
Grosvenor Hallworth Halloran Hargreave Harrowgate Hawthorne Heathcote Hennessy Hollister Horncastle
Hunnicutt Inglewood Ironside Jaramillo Kilbride Kirkpatrick Ladbrook Lamberton Lancaster Lavalle
Leatherby Lindqvist Llewellyn Loxley Lucchesi Mabry Mandeville Marchbanks Markham Mayhew Mcallister
Meriwether Milbourne Montague Moncrieff Mortimer Mulgrew Newbold Northcott Oglethorpe Ormsby Overbeck
Palliser Pennington Peverell Pickering Quartermain Ravenscroft Redgrave Ridgeway Rothwell Rutherford
Sallow Satterfield Scarborough Shackleford Silverstone Somerset Stainforth Strickland Summerville
Tavistock Templeton Thistlewood Thornbury Tolliver Treadwell Trelawney Tremaine Vandermeer Verlaine
Wainwright Wetherby Whitcombe Wickersham Willoughby Winterbourne Woodhouse Wycliffe Yarborough
""".split()

STREETS = """
Alder Amberwood Applegate Ashbury Aspen Bayberry Beacon Birchwood Blueheron Briarcliff Brookstone
Buckthorn Canary Cedarcrest Chestnut Cinnamon Cloverleaf Cobblestone Copperfield Cottonwood Crescent
Dogwood Driftwood Eaglecrest Elmhurst Evergreen Fairhaven Fernwood Fieldstone Foxglove Garnet Glenmoor
Goldenrod Granite Greenbriar Hawthorn Hazelnut Heather Hollyhock Honeysuckle Ironwood Kestrel Lakeshore
Larkspur Laurel Lavender Lilac Linden Magnolia Mallard Mapleridge Marigold Meadowlark Mistwood Moonstone
Mulberry Northwind Oakmont Orchard Osprey Pebblecreek Pinecrest Quailhollow Raven Redbud Riverbend
Rosewood Sagebrush Sandpiper Silverleaf Skylark Snowberry Sparrow Spruce Stonegate Sugarmaple Summerwind
Sycamore Tamarack Thistle Timberline Tulip Walnut Willowbrook Windmill Wisteria Woodlark Yarrow
Acorn Amberleaf Antler Arbor Ashgrove Autumnleaf Bramble Bridgewater Brightwood Brookhollow Bluebell
Buttercup Cardinal Cascade Cherrywood Chickadee Cliffrose Clover Coldwater Coralbell Cornflower
Cottontail Coyote Cranberry Creekside Crossbill Daffodil Deerfield Dewberry Dovetail Dunmore Elderberry
Emberwood Falconridge Fawn Featherstone Fiddlehead Firefly Flagstone Foxtail Frostwood Gingerwood
Gladeview Glenhollow Goldfinch Grassmere Graystone Greenleaf Grouse Harvest Hearthstone Hemlock
Heron Hickory Hidden Hillcrest Hollowbrook Huckleberry Hummingbird Indigo Ivy Jasmine Juniperhill
Kingfisher Lantern Lilypad Lodgepole Lupine Maplewood Marshwood Meadowbrook Millstone Mockingbird
Mossy Nightingale Oakhaven Oriole Otter Palisade Partridge Peachtree Pheasant Pinehurst Plover
Poppy Prairie Quarry Rainfall Ravenwood Redwing Ridgeline Robin Rockrose Sandstone Sawgrass Shadowbrook
Silverbell Snowdrop Sorrel Starling Stillwater Stonebrook Sunflower Swallow Tanager Teaberry Thornbury
Thrush Trillium Turtledove Valleyview Verbena Violet Warbler Waterlily Whippoorwill Wildflower
Willowmere Windrift Winterberry Woodbine Wrenwood Yellowwood
""".split()

SUFFIXES = ["St", "Ave", "Rd", "Dr", "Ln", "Ct", "Way", "Pl", "Cir", "Ter"]

CITIES = """
Ashford Bellmont Briarwood Brookfield Cedarfalls Clearwater Crestview Eastbrook Elmdale Fairview
Glenhaven Greenfield Harborview Hillcrest Kingsbridge Lakewood Maplewood Millbrook Northfield Oakridge
Pinehurst Riverton Rosedale Silverton Springdale Stonebridge Westfield Willowdale Windham Woodhaven
Alderbrook Amberfield Ashbourne Avonlea Baybridge Bramblewood Brightwater Calderwood Cherryvale
Coldspring Copperton Cranford Deepwater Eastwick Edgecliff Elmswood Fallbrook Foxhaven Glenmere
Goldcrest Graniteville Greystone Hartwell Havenport Hollowell Ironbridge Juniperton Kestrelvale
Lakemont Larkhaven Linwood Marbleton Meadowvale Mistvale Northgate Oakhurst Pemberton Pinebrook
Quarryville Ravensworth Redcliff Ridgefield Rivermead Sagebrook Sandhaven Shadowvale Silverbrook
Southwick Starling Stonehaven Thornfield Timberton Valemont Westbrook Whitmore Wildwood Winterhaven
""".split()

_ONSETS = "b d f g h j k l m n p r s t v z br dr fr gr kr pr tr bl fl gl kl pl sl ch sh th st".split()
_VOWELS = "a e i o u a e i o".split()
_ENDS = ["", "n", "r", "l", "s", "x", "th", "nd", "rn", "ll", "sh"]


def generated_names(n: int, salt: str) -> list[str]:
    """Pronounceable invented names ("Brolen", "Vaisa"), deterministic per salt,
    so the pools never run dry and different pools don't overlap."""
    import random
    rng = random.Random(f"ios-messages:{salt}")
    out, seen = [], set(n.lower() for n in FIRST + LAST)
    while len(out) < n:
        name = (rng.choice(_ONSETS) + rng.choice(_VOWELS) + rng.choice(_ONSETS[:22]) + rng.choice(_VOWELS)
                + rng.choice(_ENDS)).capitalize()
        if 4 <= len(name) <= 9 and name.lower() not in seen:
            seen.add(name.lower())
            out.append(name)
    return out


# Every US state name, for "City, State 12345".
STATE_NAMES = r"""alabama alaska arizona arkansas california colorado connecticut delaware florida
hawaii idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan
minnesota mississippi missouri montana nebraska nevada new\shampshire new\sjersey new\smexico new\syork
north\scarolina north\sdakota ohio oklahoma oregon pennsylvania rhode\sisland south\scarolina
south\sdakota tennessee texas utah vermont washington west\svirginia wisconsin wyoming""".split()

# Surnames that are also ordinary words: after a replaced first name they go too.
SURNAME_WORDS = set("""
brown white green black young king wood hill stone long little rich cook bell ward gray grey lane rose
park day hall wells mills price love sharp strong moon rice banks fields hunter mason carpenter walker
baker turner fisher cooper parker miller taylor webb fox wolf lamb bird hart lord bishop knight major
noble joy sweet brooks rivers woods lake marsh street church bush frost snow winter summers
""".split())

# Words that are also given names. Only replaced when clearly a name: someone
# in the chat has it, or a cue like "his name is" precedes it. Kept to words
# that really are ordinary English; rarer ones (Wyatt, Ivo) count as names.
COMMON_WORD_NAMES = set("""
will mark may june april august rose ray bill pat art grace hope joy faith sunny summer autumn dawn
day love rich chance jack sky star angel amber ruby crystal jade iris lily ivy holly olive rock
stone brook guy cash drew rob sue bell bunny cliff dash destiny forest gray hunter jewel lane
lucky major miles misty noble page penny river royal sandy skip sterling storm sunshine tiger
trinity violet wade wood young lady black white brown green new old so happy key
""".split())

# Capitalised words the name stages must not mistake for names.
NON_NAMES = set("""
january february march april may june july august september october november december
jan feb mar apr jun jul aug sep sept oct nov dec enero febrero marzo abril mayo junio julio
agosto septiembre octubre noviembre diciembre deciembre
monday tuesday wednesday thursday friday saturday sunday mondays tuesdays wednesdays thursdays
fridays saturdays sundays mon tue tues wed thu thur thurs fri sat sun lunes martes miercoles
jueves viernes sabado domingo
christmas easter thanksgiving halloween hanukkah ramadan eid diwali xmas valentine valentines
america american americans africa african asia asian europe european australia canada canadian
mexico mexican brazil brazilian china chinese india indian japan japanese korea korean russia
russian ukraine ukrainian bulgaria bulgarian turkey turkish germany german france french italy
italian spain spanish england english britain british ireland irish poland polish philippines
filipino vietnam vietnamese nigeria nigerian ghana kenya ethiopia egypt iran iraq
pakistan afghanistan cuba cuban puerto rico latino latina hispanic arabic hindi urdu portuguese
caribbean jamaica haiti colombia peru venezuela argentina chile honduras guatemala
alabama alaska arizona arkansas california colorado connecticut delaware florida hawaii
idaho illinois indiana iowa kansas kentucky louisiana maine maryland massachusetts michigan
minnesota mississippi missouri montana nebraska nevada hampshire jersey mexico york
ohio oklahoma oregon pennsylvania rhode tennessee texas utah vermont washington wisconsin
wyoming
muslim jewish catholic god lord bible church allah
tesla toyota honda ford chevy prius nissan subaru bmw mercedes uber lyft venmo zelle paypal
cashapp amazon google apple iphone ipad android samsung netflix hulu spotify youtube instagram
facebook whatsapp telegram craigslist zillow airbnb vrbo ikea costco walmart target lowes
depot fedex ups usps dhl doordash grubhub instacart comcast xfinity spectrum verizon tmobile
sprint wells fargo citi capital energy covid coronavirus wifi zoom microsoft linkedin
roomies spareroom padsplit showmojo flexmls obligo
street avenue road drive lane court boulevard place circle parkway terrace trail highway blvd
mr mrs ms miss sir madam bro dude sis mom dad mama papa grandma grandpa uncle aunt auntie
okay thanks thank please hello hey yes yeah nope sorry happy merry birthday congrats
""".split())
