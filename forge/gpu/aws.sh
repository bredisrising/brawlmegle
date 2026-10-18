#!/bin/bash
# The forge's GPU box on AWS (us-west-2). Run where the AWS CLI is set up (bingus):
#
#   bash aws.sh launch    # key pair, security group, instance, Elastic IP (once)
#   bash aws.sh status    # state, type, public + private IP
#   bash aws.sh stop      # stop paying for the GPU (the disk and the Elastic IP stay: about $0.50/day)
#   bash aws.sh start     # back up; the service starts itself and warms up in about 2 min
#   bash aws.sh ssh [cmd] # shell on the box
#
# Security: SSH only from bingus; the service port (8790) only from the brawlegle box (its security group for the
# private VPC address, its Elastic IP for the public one) and bingus. Calls also need the key in /etc/forge3d.env.
set -euo pipefail
AWS=${AWS:-$HOME/.local/bin/aws}
export AWS_DEFAULT_REGION=us-west-2
NAME=brawlegle-gpu
TYPE=${FORGE3D_TYPE:-g6e.2xlarge}
KEY=$HOME/.ssh/brawlegle-gpu.pem
BINGUS_IP=73.225.196.193/32
BRAWLEGLE_IP=54.149.60.196/32
BRAWLEGLE_SG=sg-081a34b5229fa0ca4
TAGS="{Key=Project,Value=brawlegle},{Key=Name,Value=$NAME}"

instance() {
  $AWS ec2 describe-instances --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query "Reservations[].Instances[0].InstanceId" --output text
}
ip() { $AWS ec2 describe-addresses --filters "Name=tag:Name,Values=$NAME" --query "Addresses[0].PublicIp" --output text; }

case "${1:-status}" in
launch)
  [ -n "$(instance)" ] && { echo "already there: $(instance)"; exit 0; }
  if [ ! -f "$KEY" ]; then
    $AWS ec2 create-key-pair --key-name $NAME --key-type ed25519 --tag-specifications "ResourceType=key-pair,Tags=[$TAGS]" \
      --query KeyMaterial --output text >"$KEY"
    chmod 600 "$KEY"
  fi
  VPC=$($AWS ec2 describe-security-groups --group-ids $BRAWLEGLE_SG --query "SecurityGroups[0].VpcId" --output text)
  SG=$($AWS ec2 describe-security-groups --filters "Name=group-name,Values=$NAME" --query "SecurityGroups[0].GroupId" --output text)
  if [ "$SG" = "None" ]; then
    SG=$($AWS ec2 create-security-group --group-name $NAME --vpc-id "$VPC" --description "brawlegle forge GPU box" \
      --tag-specifications "ResourceType=security-group,Tags=[$TAGS]" --query GroupId --output text)
    $AWS ec2 authorize-security-group-ingress --group-id "$SG" --ip-permissions \
      "IpProtocol=tcp,FromPort=22,ToPort=22,IpRanges=[{CidrIp=$BINGUS_IP,Description=bingus}]" \
      "IpProtocol=tcp,FromPort=8790,ToPort=8790,IpRanges=[{CidrIp=$BRAWLEGLE_IP,Description=brawlegle-box},{CidrIp=$BINGUS_IP,Description=bingus}],UserIdGroupPairs=[{GroupId=$BRAWLEGLE_SG,Description=brawlegle-box-private}]" >/dev/null
  fi
  AMI=$($AWS ssm get-parameter --name /aws/service/deeplearning/ami/x86_64/base-oss-nvidia-driver-gpu-ubuntu-22.04/latest/ami-id --query Parameter.Value --output text)
  ID=$($AWS ec2 run-instances --image-id "$AMI" --instance-type "$TYPE" --key-name $NAME --security-group-ids "$SG" \
    ${FORGE3D_SUBNET:+--subnet-id $FORGE3D_SUBNET} \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":200,"VolumeType":"gp3","Iops":6000,"Throughput":500}}]' \
    --tag-specifications "ResourceType=instance,Tags=[$TAGS]" "ResourceType=volume,Tags=[$TAGS]" \
    --query "Instances[0].InstanceId" --output text)
  echo "instance $ID ($TYPE, $AMI)"
  $AWS ec2 wait instance-running --instance-ids "$ID"
  ALLOC=$($AWS ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[$TAGS]" --query AllocationId --output text)
  $AWS ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC" >/dev/null
  echo "elastic ip $(ip)"
  ;;
status)
  ID=$(instance)
  [ -z "$ID" ] && { echo "no $NAME instance"; exit 0; }
  $AWS ec2 describe-instances --instance-ids "$ID" \
    --query "Reservations[0].Instances[0].[InstanceId,State.Name,InstanceType,PublicIpAddress,PrivateIpAddress,Placement.AvailabilityZone]" --output text
  ;;
stop) $AWS ec2 stop-instances --instance-ids "$(instance)" --query "StoppingInstances[0].CurrentState.Name" --output text ;;
start) $AWS ec2 start-instances --instance-ids "$(instance)" --query "StartingInstances[0].CurrentState.Name" --output text ;;
ssh) shift; ssh -i "$KEY" -o StrictHostKeyChecking=accept-new ubuntu@"$(ip)" "$@" ;;
*) echo "usage: aws.sh launch|status|stop|start|ssh"; exit 1 ;;
esac
