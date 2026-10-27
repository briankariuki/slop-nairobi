[out:json][timeout:180];
(
  nwr["name"~"^(Kenyatta International Convention Centre|KICC|Times Tower|Parliament Buildings|Parliament of Kenya|Hilton|Nairobi Hilton|Teleposta Towers|Anniversary Towers|Nation Centre|I&M Bank Tower|Uchumi House|Kenya Archives|Kenya National Archives|Jamia Mosque|Holy Family Basilica|All Saints Cathedral|City Hall|Nairobi City Hall|Railway Station|Nairobi Railway Station|Nairobi Railway Museum|Uhuru Park|Central Park|Jeevanjee Gardens|Kenya National Theatre|University of Nairobi|Norfolk Hotel|Fairmont The Norfolk|Sarova Stanley|The Stanley|Kencom House|Cooperative Bank House|Co-operative Bank House|UAP Old Mutual Tower|Britam Tower|Nyayo House|Supreme Court of Kenya|Milimani Law Courts|Kenya Railways Headquarters|GPO|General Post Office|Mama Ngina Street|Kipande House|Lillian Towers|Bank of Kenya|Central Bank of Kenya|National Archives|Ambassadeur Hotel|Nairobi Serena Hotel|Serena Hotel|Kenyatta Mausoleum|Nyayo Monument|Freedom Corner)$",i](-1.3050,36.8000,-1.2680,36.8420);
  nwr["tourism"~"^(attraction|museum|viewpoint|artwork)$"]["name"](-1.3050,36.8000,-1.2680,36.8420);
  nwr["historic"]["name"](-1.3050,36.8000,-1.2680,36.8420);
  way["building"]["height"](-1.3050,36.8000,-1.2680,36.8420);
  way["building"]["building:levels"~"^([1-9][0-9]|[1-9][0-9][0-9])$"](-1.3050,36.8000,-1.2680,36.8420);
  way["building"]["floors"~"^([1-9][0-9]|[1-9][0-9][0-9])$"](-1.3050,36.8000,-1.2680,36.8420);
  relation["type"="building"]["name"](-1.3050,36.8000,-1.2680,36.8420);
);
out geom;
