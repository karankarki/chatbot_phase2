class ChatPrefill {
  final String? name;
  final String? mobile;
  final String? chargerSerial;
  final String? chargerModel; // 'Spin Air' | 'Tata/Compact'

  const ChatPrefill({
    this.name,
    this.mobile,
    this.chargerSerial,
    this.chargerModel,
  });

  Map<String, dynamic> toJson() => {
        if (name != null) 'prefillName': name,
        if (mobile != null) 'prefillMobile': mobile,
        if (chargerSerial != null) 'prefillChargerSerial': chargerSerial,
        if (chargerModel != null) 'prefillChargerModel': chargerModel,
      };
}
